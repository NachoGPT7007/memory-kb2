#!/usr/bin/env node
/**
 * eval-precision.mjs —— 用 PrecisionMemBench 测 kb2 的检索精度。
 *
 * 基准：https://github.com/tenurehq/precisionmembench
 *   - 35 个 belief（含别名、替代链、跨用户隔离样本）
 *   - 77 个 case，13 类，每类断言「必须/不得返回哪些 belief ID」
 *   - 只有 relevantBeliefs 这一层依赖 provider（其余三层是本地推导）
 *
 * 本脚本只测 relevantBeliefs 断言：把 belief 建成 kb2 的卡，逐 case 检索，
 * 检查返回的卡是否满足 shouldOnlyInclude / mustExclude。
 *
 * 用法：
 *   node bench/eval-precision.mjs /tmp/pmb
 */
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const DATA = process.argv[2] ?? '/tmp/pmb'
const VAULT = join(DATA, 'vault')
const beliefs = JSON.parse(readFileSync(join(DATA, 'beliefs.seed.json'), 'utf8'))
const cases = JSON.parse(readFileSync(join(DATA, 'retrieval.cases.json'), 'utf8'))

// 1) 把 belief 建成卡：文件名用 _id，便于检索结果映射回 belief
rmSync(VAULT, { recursive: true, force: true })
mkdirSync(join(VAULT, 'beliefs'), { recursive: true })
for (const b of beliefs) {
  const md = [
    '---',
    `title: ${b.canonical_name}`,
    `status: ${b.epistemic_status === 'superseded' ? 'deleted' : 'active'}`,
    `user: ${b.user_id}`,
    '---',
    '',
    `## 内容`,
    b.content,
    '',
    `## 为什么重要`,
    b.why_it_matters ?? '',
    '',
    `## 别名`,
    (b.aliases ?? []).join(', '),
    '',
    `## 类型`,
    `${b.type} · scope=${(b.scope ?? []).join(',')}`,
    '',
  ].join('\n')
  writeFileSync(join(VAULT, 'beliefs', `${b._id}.md`), md, 'utf8')
}
console.log(`已建 ${beliefs.length} 张 belief 卡`)

process.env.MEM_VAULT = VAULT
const { build, hybridQuery } = await import('../src/index.mjs')
const r = await build()
console.log(`索引：${r.nCards} 卡 / ${r.nAtoms} 原子`)

// 2) 逐 case 检索并判分
const idByPath = new Map(beliefs.map((b) => [b._id, b]))
let pass = 0
let total = 0
const byCategory = new Map()
const failures = []

for (const c of cases) {
  const expect = c.expect?.relevantBeliefs
  if (!expect || Object.keys(expect).length === 0) continue
  total += 1
  const { ranked } = hybridQuery(c.query, { limit: 10 })
  // 从 path 提取 belief id
  const got = ranked
    .map((row) => {
      const m = /\/(b-[^/]+)\.md$/.exec(row.path ?? '')
      return m ? m[1] : null
    })
    .filter(Boolean)
  const gotSet = new Set(got)

  let ok = true
  const reasons = []
  if (Array.isArray(expect.shouldOnlyInclude)) {
    if (expect.shouldOnlyInclude.length === 0) {
      // 基准语义：shouldOnlyInclude = [] 表示「只应返回空」。
      // 返回任何 belief 都是失败——这一条此前被跳过，导致通过率虚高。
      if (got.length > 0) { ok = false; reasons.push(`应返回空，实际返回 ${got.length} 条`) }
    } else {
      const extra = got.filter((id) => !expect.shouldOnlyInclude.includes(id))
      if (extra.length > 0) { ok = false; reasons.push(`多返回 ${extra.join(',')}`) }
      const missing = expect.shouldOnlyInclude.filter((id) => !gotSet.has(id))
      if (missing.length > 0) { ok = false; reasons.push(`漏返回 ${missing.join(',')}`) }
    }
  }
  if (Array.isArray(expect.mustExclude)) {
    const bad = expect.mustExclude.filter((id) => gotSet.has(id))
    if (bad.length > 0) { ok = false; reasons.push(`不应返回 ${bad.join(',')}`) }
  }
  if (Array.isArray(expect.mustInclude)) {
    const missing = expect.mustInclude.filter((id) => !gotSet.has(id))
    if (missing.length > 0) { ok = false; reasons.push(`漏返回 ${missing.join(',')}`) }
  }

  if (ok) pass += 1
  else failures.push({ id: c.caseId, cat: c.category, q: c.query.slice(0, 50), reasons })
  const cat = c.category ?? '(未分类)'
  const cur = byCategory.get(cat) ?? { pass: 0, total: 0 }
  cur.total += 1
  if (ok) cur.pass += 1
  byCategory.set(cat, cur)
}

console.log(`\n=== 结果：${pass} / ${total} = ${((pass / total) * 100).toFixed(1)}% ===\n`)
console.log('分类明细：')
for (const [cat, v] of [...byCategory.entries()].sort((a, b) => b[1].total - a[1].total)) {
  console.log(`  ${String(v.pass).padStart(2)}/${String(v.total).padStart(2)}  ${cat}`)
}
if (failures.length) {
  console.log(`\n失败 ${failures.length} 例（前 8）：`)
  for (const f of failures.slice(0, 8)) console.log(`  - [${f.cat}] ${f.q}\n      ${f.reasons.join(' | ')}`)
}
