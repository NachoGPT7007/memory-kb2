#!/usr/bin/env node
/**
 * eval-wiki.mjs —— 法学 wiki 库的两项检索指标（索引层，BM25 路，不花模型调用）
 *
 *   A. 概念名 recall@1：拿卡片标题当查询，看 top1 是否命中该卡（941 条，对齐 BENCHMARK 的 98.9%）
 *   B. 正文细节命中：从卡片正文抽一段 40–120 字的原句当查询，看 top1/top3 是否命中该卡。
 *      正文没入索引时这一项必然很低——它测的就是「正文细节查不查得到」。
 *
 * 用法：node bench/eval-wiki.mjs <vault> [--index PATH] [--json-out FILE]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const get = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d }
const VAULT = argv.find((a) => !a.startsWith('--') && a.includes('/'))
if (!VAULT) { console.error('用法：node bench/eval-wiki.mjs <vault> [--index PATH]'); process.exit(2) }
const INDEX = get('index', null)
process.env.MEM_VAULT = VAULT
if (INDEX) process.env.MEM_INDEX = INDEX
const { query } = await import(join(import.meta.dirname, '..', 'src', 'index.mjs'))

function walk(dir, base = dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, base, acc)
    else if (e.name.endsWith('.md')) acc.push(p.slice(base.length + 1))
  }
  return acc
}
const files = walk(VAULT)
const cards = []
for (const rel of files) {
  const text = readFileSync(join(VAULT, rel), 'utf8')
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  const fm = m?.[1] || ''
  const title = (/^title:\s*(.+)$/m.exec(fm)?.[1] || /^card:\s*(.+)$/m.exec(fm)?.[1] || '').trim().replace(/^"|"$/g, '')
  const body = text.split(/^---$/m).slice(2).join('')
  // 正文抽段：非标题、长度 40–120 字的第一条
  const snippet = body.split('\n').map((l) => l.trim())
    .find((l) => l && !l.startsWith('#') && l.length >= 40 && l.length <= 120) || ''
  if (title) cards.push({ rel, title, snippet })
}

function rate(list, key, limit) {
  let hit = 0, n = 0
  for (const c of list) {
    if (!c[key]) continue
    n++
    const { ranked } = query(c[key], { limit })
    if ((ranked[0]?.path || '') === c.rel) hit++
  }
  return { n, hit, pct: +(100 * hit / (n || 1)).toFixed(1) }
}
const A1 = rate(cards, 'title', 1)
const A3 = rate(cards, 'title', 3)
const B1 = rate(cards, 'snippet', 1)
const B3 = rate(cards, 'snippet', 3)
const out = { vault: VAULT, index: INDEX || '(default)', cards: cards.length, title_recall1: A1, title_recall3: A3, body_top1: B1, body_top3: B3 }
if (!argv.includes('--json')) {
  console.log(`库：${VAULT}  索引：${INDEX || '默认'}  卡：${cards.length}`)
  console.log(`A 概念名（标题当查询）：recall@1 ${A1.pct}%（${A1.hit}/${A1.n}）  recall@3 ${A3.pct}%`)
  console.log(`B 正文细节（正文原句当查询）：top1 ${B1.pct}%（${B1.hit}/${B1.n}）  top3 ${B3.pct}%`)
}
const j = get('json-out', null)
if (j) { const { writeFileSync } = await import('node:fs'); writeFileSync(j, JSON.stringify(out, null, 1)) }
