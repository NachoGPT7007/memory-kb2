#!/usr/bin/env node
// 老卡原子标准化（第 1 + 2 层，纯确定性，不调模型）
//
// 只做两件事，都能逐行 diff：
//   1) 原子 text 去掉行首编号/列表符号（normalizeCard 本来就该做的第一件事）
//   2) formatVersion 统一为 2
//
// 不做的事（明确记录，避免误解）：
//   - 不改箭头流程（需要语义改写，第 3 层）
//   - 不改 nature 分类（需要语义判断）
//   - 不重排字段顺序、不补 origin（收益低于风险）
//
// 安全：
//   - 默认 dry-run，--apply 才写
//   - 写之前先备份到 vault 同级 .backup/refactor-<ts>/（vault 不在 git 管控下）
//   - 只做行级替换（重写 atoms 块里的 text 行），其余字节不动
//
// 用法：
//   node scripts/refactor-atoms-normalize.mjs --dry-run --limit 3
//   node scripts/refactor-atoms-normalize.mjs --dry-run
//   node scripts/refactor-atoms-normalize.mjs --apply

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { resolveVault } from '../src/paths.mjs'
import { classifyAtom } from './audit-atoms.mjs'

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d }

const VAULT = val('--vault', resolveVault())
const APPLY = has('--apply')
const LIMIT = Number(val('--limit', 0)) || Infinity
const ONLY_SOURCE = val('--source', null)
const MIN_AFTER = 12   // 清洗后短于此长度就保留原样，避免把一个合格原子改成过短

/** 去掉行首列表符号/编号，最多剥三层（如 "- 1. "）。只在开头剥，不碰正文里的连字符。 */
export function stripMarker(text) {
  let s = String(text || '')
  for (let i = 0; i < 3; i++) {
    const before = s
    s = s.replace(/^\s*(?:[-*•·]\s+|\d+[.、)]\s*|[（(]\d+[）)]\s*|[①-⑳]\s*)/, '')
    if (s === before) break
  }
  return s.trim()
}

/** 在 frontmatter 的 atoms 块里重写 text 行；其余行逐字节不动。 */
function rewriteAtomTexts(frontmatter, fn) {
  const lines = frontmatter.split('\n')
  const out = []
  let changed = 0
  for (const line of lines) {
    const m = /^(\s{4}text:\s*)(.*)$/.exec(line)
    if (!m) { out.push(line); continue }
    const raw = m[2]
    // 值可能带引号；取出裸文本
    const quoted = /^"(.*)"$/s.test(raw)
    const bare = quoted ? raw.replace(/^"(.*)"$/s, '$1').replace(/\\"/g, '"') : raw
    const next = fn(bare)
    if (next === bare) { out.push(line); continue }
    changed++
    const value = /[:#\[\]{}"',&*!|>%@`]/.test(next) ? `"${next.replace(/"/g, '\\"')}"` : next
    out.push(m[1] + value)
  }
  return { text: out.join('\n'), changed }
}

async function main() {
  const t0 = Date.now()
  const backupDir = path.join(VAULT, '.backup', `refactor-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`)

  const walk = async (dir, base = dir, acc = []) => {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { if (!['.git', '.index', 'node_modules', '.backup'].includes(e.name)) await walk(p, base, acc) }
      else if (e.name.endsWith('.md')) acc.push(path.relative(base, p))
    }
    return acc
  }
  let files = await walk(VAULT)
  if (ONLY_SOURCE) {
    const keep = []
    for (const rel of files) {
      try {
        const t = await fs.readFile(path.join(VAULT, rel), 'utf8')
        const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(t)
        const src = /^source:\s*(.*)$/m.exec(fm?.[1] || '')?.[1]?.trim() || ''
        if (src === ONLY_SOURCE) keep.push(rel)
      } catch {}
    }
    files = keep
  }
  if (LIMIT !== Infinity) files = files.slice(0, LIMIT)

  const stat = { scanned: 0, touchedFiles: 0, touchedAtoms: 0, skippedShort: 0, fvPatched: 0, beforeBad: 0, afterBad: 0, totalAtoms: 0 }
  const previews = []

  for (const rel of files) {
    const abs = path.join(VAULT, rel)
    let text
    try { text = await fs.readFile(abs, 'utf8') } catch { continue }
    stat.scanned++
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
    if (!m) continue
    const fm = m[1]
    const rest = text.slice(m[0].length)

    // 1) 原子 text 去编号
    const { text: fm2, changed } = rewriteAtomTexts(fm, (bare) => {
      const cleaned = stripMarker(bare)
      if (cleaned.length < MIN_AFTER) { stat.skippedShort++; return bare }
      return cleaned
    })

    // 2) formatVersion 统一为 2
    let fm3 = fm2
    if (!/^formatVersion:\s*2$/m.test(fm3)) {
      if (/^formatVersion:/m.test(fm3)) fm3 = fm3.replace(/^formatVersion:.*$/m, 'formatVersion: 2')
      else fm3 = 'formatVersion: 2\n' + fm3
      stat.fvPatched++
    }

    const next = `---\n${fm3}\n---\n${rest}`
    if (next === text) continue
    stat.touchedFiles++
    stat.touchedAtoms += changed

    // 质量变化（用同一套判定，只看原子）
    const atomsOf = (f) => {
      const out = []
      const am = /^atoms:\n([\s\S]*?)(?=^\S|$(?![\s\S]))/m.exec(f)
      if (!am) return out
      let cur = null
      for (const line of am[1].split(/\n/)) {
        const idM = /^ {2}- id:\s*(\S+)/.exec(line)
        if (idM) { if (cur) out.push(cur); cur = { text: '', nature: 'fact' }; continue }
        if (!cur) continue
        const kv = /^ {4}([a-zA-Z_]+):\s*(.*)$/.exec(line)
        if (kv) cur[kv[1]] = kv[2].replace(/^"(.*)"$/s, '$1')
      }
      if (cur) out.push(cur)
      return out
    }
    const a0 = atomsOf(fm), a1 = atomsOf(fm3)
    stat.beforeBad += a0.filter((a) => classifyAtom(a.text, { nature: a.nature }).verdict !== 'pass').length
    stat.afterBad += a1.filter((a) => classifyAtom(a.text, { nature: a.nature }).verdict !== 'pass').length
    stat.totalAtoms += a0.length

    if (previews.length < 3 && changed) {
      const pairs = []
      for (let i = 0; i < Math.min(a0.length, a1.length); i++) {
        if (a0[i].text !== a1[i].text) pairs.push({ before: a0[i].text, after: a1[i].text })
      }
      previews.push({ path: rel, changed, pairs: pairs.slice(0, 3) })
    }

    if (APPLY) {
      const bak = path.join(backupDir, rel)
      await fs.mkdir(path.dirname(bak), { recursive: true })
      await fs.copyFile(abs, bak)
      const tmp = abs + '.tmp'
      await fs.writeFile(tmp, next, 'utf8')
      await fs.rename(tmp, abs)
    }
  }

  const pct = (n, d) => (d ? (n / d * 100).toFixed(1) + '%' : '-')
  console.log(`${APPLY ? '【已写入】' : '【dry-run，未写入】'} 扫描 ${stat.scanned} 张卡`)
  console.log(`将被修改：${stat.touchedFiles} 张卡 / ${stat.touchedAtoms} 条原子 text`)
  if (stat.fvPatched) console.log(`formatVersion 统一为 2：${stat.fvPatched} 张卡`)
  if (stat.skippedShort) console.log(`清洗后会短于 ${MIN_AFTER} 字而保留原样：${stat.skippedShort} 条`)
  console.log(`原子质量（同一套判定）：改前不合格 ${stat.beforeBad}/${stat.totalAtoms} ${pct(stat.beforeBad, stat.totalAtoms)} → 改后 ${stat.afterBad}/${stat.totalAtoms} ${pct(stat.afterBad, stat.totalAtoms)}`)

  if (previews.length) {
    console.log('\n预览（前 3 张卡，各 3 条）：')
    for (const p of previews) {
      console.log(`  ${p.path}（改 ${p.changed} 条）`)
      for (const x of p.pairs) {
        console.log(`    旧：${String(x.before).slice(0, 74)}`)
        console.log(`    新：${String(x.after).slice(0, 74)}`)
      }
    }
  }
  if (APPLY) console.log(`\n备份目录：${backupDir}`)
  console.log(`耗时 ${Date.now() - t0} ms`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === decodeURIComponent(new URL(import.meta.url).pathname)) main()
