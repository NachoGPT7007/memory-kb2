#!/usr/bin/env node
// 实验：对历史卡「重抽原子」，归纳旧原子的共性缺陷
//
// 只读卡片、只调 LLM，**不改 vault、不写库**。结果落 JSON 供归纳。
//
// 思路：
//   1) 取指定 source 的卡（默认 memory-consolidation，那是坏率 51.2% 的通道）
//   2) 用当前生产提示词（summarizeTurn）对卡片正文重新提炼原子
//   3) 新旧原子逐条过 classifyAtom，算坏率变化
//   4) 归纳：旧原子不合格的原因分布 + 长度/nature 特征 + 新旧对照样本
//
// 用法：
//   node scripts/experiment-rextract-atoms.mjs --limit 3        # 试管线
//   node scripts/experiment-rextract-atoms.mjs --all            # 全部
//   node scripts/experiment-rextract-atoms.mjs --source memory-consolidation --limit 63
//   --out /path/result.json

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { resolveVault, resolveDbPath } from '../src/paths.mjs'
import { classifyAtom } from './audit-atoms.mjs'

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d }

const VAULT = val('--vault', resolveVault())
const DB = resolveDbPath(VAULT)
const SOURCE = val('--source', 'memory-consolidation')
const LIMIT = has('--all') ? Infinity : Number(val('--limit', 3))
const OUT = val('--out', '/tmp/kb2-rextract.jsonl')
// 并发路数：瓶颈是 LLM 往返延迟（单次 5-8 秒），并发是唯一有效的加速手段。
// 子代理不解决这个问题——它们同样要一个个等 API，还多出各自的冷启动。
const CONCURRENCY = Math.max(1, Number(val('--concurrency', 4)))

// ---- LLM（与独立进程通道同一适配器） ----
// 插件包位置用环境变量指定，默认按 DSH 生态的约定推断；不写死本机绝对路径。
import os from 'node:os'
const PLUGIN = process.env.MEM_PLUGIN_DIR || path.join(os.homedir(), 'dsh-armory', 'packages', 'dsh-memory-kb2')
const { createLlmFromEnv } = await import(path.join(PLUGIN, 'lib', 'llm-openai.js'))
const { summarizeTurn } = await import(path.join(PLUGIN, 'lib', 'capture.js'))

// 从 .credentials.yaml 取 key（与 embed-api 同一顺序）
const fsSync = await import('node:fs')
function credKey(name) {
  if (process.env[name]) return process.env[name]
  const home = process.env.DSH_HOME || path.join(process.env.HOME || '', '.dsh')
  const file = process.env.DSH_CREDENTIALS || path.join(home, '.credentials.yaml')
  try {
    const t = fsSync.readFileSync(file, 'utf8')
    const refs = t.includes('\nrefs:') ? t.split('\nrefs:')[1].split(/\n\w/)[0] : t
    const m = refs.match(new RegExp(`^\\s*${name}:\\s*(\\S+)`, 'm'))
    return m ? m[1].replace(/^["']|["']$/g, '') : ''
  } catch { return '' }
}

const llm = createLlmFromEnv({
  MEMORY_LLM_BASE_URL: process.env.MEMORY_LLM_BASE_URL || 'https://api.deepseek.com',
  MEMORY_LLM_KEY: credKey('DEEPSEEK_API_KEY'),
  MEMORY_LLM_MODEL: process.env.MEMORY_LLM_MODEL || 'deepseek-chat',
})
if (!llm) {
  console.error('LLM 未配置（需要 DEEPSEEK_API_KEY）')
  process.exit(2)
}
const route = { provider: 'openai-compat', model: process.env.MEMORY_LLM_MODEL || 'deepseek-chat' }

// ---- 选卡 ----
const { DatabaseSync } = await import('node:sqlite')
const db = new DatabaseSync(DB, { readOnly: true })
const cards = db.prepare(`
  SELECT id, path, title, status FROM cards
  WHERE status != 'deleted' ORDER BY path
`).all()

const atomStmt = db.prepare(`SELECT text, nature FROM atoms WHERE card_id = ? AND active = 1 AND nature NOT IN ('title','body')`)

// 按 frontmatter 的 source 过滤
const picked = []
for (const c of cards) {
  let src = ''
  try {
    const t = await fs.readFile(path.join(VAULT, c.path), 'utf8')
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(t)
    const s = /^source:\s*(.*)$/m.exec(m[1])
    src = (s?.[1] || '').trim()
  } catch { continue }
  if (src !== SOURCE) continue
  picked.push({ ...c, oldAtoms: atomStmt.all(c.id) })
  if (picked.length >= LIMIT) break
}
db.close()

console.log(`源=${SOURCE} 命中 ${picked.length} 张卡，开始重抽（模型 ${route.model}）`)

const out = []
let done = 0

async function handleCard(c) {
  let text
  try { text = await fs.readFile(path.join(VAULT, c.path), 'utf8') } catch { return null }
  const bodyMatch = /^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  const body = (bodyMatch ? bodyMatch[1] : text).trim()

  let newAtoms = []
  let note = ''
  try {
    const res = await summarizeTurn(llm, route, body, {
      signal: AbortSignal.timeout(90_000),
      existing: [],
      maxTokens: 3000,
    })
    if (res?.cards?.length) newAtoms = res.cards[0].atoms || []
    else if (res?.append_to) note = 'model-append-to'
    else note = 'model-save-false'
  } catch (e) {
    note = 'llm-error:' + String(e?.message || e).slice(0, 80)
  }

  const oldV = c.oldAtoms.map((a) => ({ ...a, ...classifyAtom(a.text, { nature: a.nature }) }))
  const newV = newAtoms.map((a) => ({ text: a.text, nature: a.nature, fact_key: a.fact_key, ...classifyAtom(a.text, { nature: a.nature }) }))

  const rec = {
    path: c.path, title: c.title, status: c.status, note,
    old: { n: oldV.length, bad: oldV.filter((x) => x.verdict !== 'pass').length, atoms: oldV },
    new: { n: newV.length, bad: newV.filter((x) => x.verdict !== 'pass').length, atoms: newV },
  }
  return rec
}

// 并发池：保持结果顺序与 picked 一致
const results = new Array(picked.length).fill(null)
let cursor = 0
async function worker() {
  while (true) {
    const i = cursor++
    if (i >= picked.length) return
    const c = picked[i]
    const rec = await handleCard(c)
    if (!rec) continue
    results[i] = rec
    done++
    const p = (n, d) => d ? (n / d * 100).toFixed(0) + '%' : '-'
    console.log(`[${done}/${picked.length}] 旧 ${rec.old.n}条/${p(rec.old.bad, rec.old.n)}坏 → 新 ${rec.new.n}条/${p(rec.new.bad, rec.new.n)}坏  ${rec.note || ''}  ${c.path.slice(0, 50)}`)
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, picked.length) }, worker))
for (const r of results) if (r) out.push(r)

await fs.writeFile(OUT, out.map((r) => JSON.stringify(r)).join('\n'), 'utf8')
console.log(`\n结果写入 ${OUT}`)

// ---- 即时汇总 ----
const oldN = out.reduce((s, r) => s + r.old.n, 0), oldBad = out.reduce((s, r) => s + r.old.bad, 0)
const newN = out.reduce((s, r) => s + r.new.n, 0), newBad = out.reduce((s, r) => s + r.new.bad, 0)
console.log(`\n旧原子 ${oldN} 条，坏 ${oldBad}（${(oldBad / oldN * 100).toFixed(1)}%）`)
console.log(`新原子 ${newN} 条，坏 ${newBad}（${newN ? (newBad / newN * 100).toFixed(1) : '-'}%）`)
console.log(`无法重抽：${out.filter((r) => r.note).length} 张（${[...new Set(out.map((r) => r.note).filter(Boolean))].join(',') || '无'}）`)
