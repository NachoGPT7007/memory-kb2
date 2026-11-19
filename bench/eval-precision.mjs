#!/usr/bin/env node
/**
 * eval-precision.mjs —— 用 PrecisionMemBench 测 kb2 的检索精度（服务层口径）
 *
 * 基准：https://github.com/tenurehq/precisionmembench
 *   - 35 个 belief（含别名、替代链、跨用户隔离样本）
 *   - 77 个 case，13 类，每类断言「必须/不得返回哪些 belief ID」
 *   - 只有 relevantBeliefs 这一层依赖 provider（其余三层是本地推导）
 *
 * 2026-11-20 改造（两处，都是为了能测到服务层的改动）：
 *   1. 检索改走真实 MCP stdio 往返（原版直接 import src/index.mjs 的 hybridQuery，
 *      测的是索引层；抽取式改写与 scope 过滤都在 server.mjs，索引层测不到）
 *   2. belief 卡写入 frontmatter `scope:`（阶段 2 的 scope 过滤需要结构化字段；
 *      原版把 scope 写在正文里，检索层看不见）
 *
 * 口径不变：BM25 路（MEM_VECTOR=0）、limit 10、空断言 shouldOnlyInclude: [] 必须算条件。
 *
 * 用法：
 *   node bench/eval-precision.mjs /tmp/pmb                 # 基线
 *   node bench/eval-precision.mjs /tmp/pmb --alias         # 开抽取式改写
 *   node bench/eval-precision.mjs /tmp/pmb --scope         # 传 case 的 scope 做过滤
 *   node bench/eval-precision.mjs /tmp/pmb --json-out x.json
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER = process.env.EVAL_SERVER || join(HERE, '..', 'src', 'server.mjs')
const argv = process.argv.slice(2)
const get = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d }
const DATA = argv.find((a) => !a.startsWith('--') && !/^\d+$/.test(a)) ?? '/tmp/pmb'
const VAULT = join(DATA, 'vault')
const LIMIT = Number(get('limit', 10))
const USE_ALIAS = argv.includes('--alias') ? '1' : '0'
const USE_SCOPE = argv.includes('--scope')
const beliefs = JSON.parse(readFileSync(join(DATA, 'beliefs.seed.json'), 'utf8'))
const cases = JSON.parse(readFileSync(join(DATA, 'retrieval.cases.json'), 'utf8'))

// ---- 1) 建 card（含 scope frontmatter）；索引由 src/index.mjs 的 build 重建
rmSync(VAULT, { recursive: true, force: true })
mkdirSync(join(VAULT, 'beliefs'), { recursive: true })
for (const b of beliefs) {
  const md = [
    '---',
    `title: ${b.canonical_name}`,
    `status: ${b.epistemic_status === 'superseded' ? 'deleted' : 'active'}`,
    `user: ${b.user_id}`,
    `scope: [${(b.scope ?? []).join(', ')}]`,
    '---',
    '',
    '## 内容',
    b.content,
    '',
    '## 为什么重要',
    b.why_it_matters ?? '',
    '',
    '## 别名',
    (b.aliases ?? []).join(', '),
    '',
    '## 类型',
    `${b.type}`,
    '',
  ].join('\n')
  writeFileSync(join(VAULT, 'beliefs', `${b._id}.md`), md, 'utf8')
}
process.env.MEM_VAULT = VAULT
const { build } = await import(join(HERE, '..', 'src', 'index.mjs'))
const built = await build()
console.log(`已建 ${beliefs.length} 张 belief 卡；索引 ${built.nCards} 卡 / ${built.nAtoms} 原子`)

// ---- 2) 服务层检索
const env = { ...process.env, MEM_VAULT: VAULT, MEM_VECTOR: '0', MEM_RERANK: '0', MEM_ALIAS: USE_ALIAS, MEM_DEFAULT_LIMIT: String(LIMIT) }
const child = spawn(process.execPath, [SERVER], { env, stdio: ['pipe', 'pipe', 'pipe'] })
let buf = '', stderr = ''
const pending = new Map()
child.stderr.on('data', (d) => { stderr += String(d) })
child.stdout.on('data', (d) => {
  buf += String(d)
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
    if (!line) continue
    let m; try { m = JSON.parse(line) } catch { continue }
    if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  }
})
let nextId = 10
const rpc = (method, params) => new Promise((res, rej) => {
  const id = nextId++
  const to = setTimeout(() => rej(new Error(method + ' 超时')), 60000)
  pending.set(id, (m) => { clearTimeout(to); res(m) })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
})
await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'eval-precision', version: '1' } })
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')

let pass = 0, total = 0
const byCat = new Map()
const failures = []
for (const c of cases) {
  const expect = c.expect?.relevantBeliefs
  if (!expect || !Object.keys(expect).length) continue
  total++
  const args = { query: c.query, limit: LIMIT }
  if (USE_SCOPE && Array.isArray(c.scope) && c.scope.length) args.scope = c.scope
  let got = []
  try {
    const r = await rpc('tools/call', { name: 'memory_search', arguments: args })
    const text = (r.result?.content || []).map((x) => x.text || '').join('\n')
    got = [...text.matchAll(/路径：\S*?\/?(b-[^/\s]+)\.md/g)].map((m) => m[1])
  } catch (e) { failures.push({ id: c.caseId, cat: c.category, q: c.query.slice(0, 50), reasons: ['调用失败 ' + e.message] }); }
  const set = new Set(got)
  let ok = true
  const reasons = []
  if (Array.isArray(expect.shouldOnlyInclude)) {
    if (expect.shouldOnlyInclude.length === 0) {
      // 基准语义：空数组 = 只应返回空。返回任何 belief 都是失败（曾因此把 13.2% 虚报到 44.7%）
      if (got.length > 0) { ok = false; reasons.push(`应返回空，实际返回 ${got.length} 条`) }
    } else {
      const extra = got.filter((id) => !expect.shouldOnlyInclude.includes(id))
      if (extra.length) { ok = false; reasons.push(`多返回 ${extra.join(',')}`) }
      const missing = expect.shouldOnlyInclude.filter((id) => !set.has(id))
      if (missing.length) { ok = false; reasons.push(`漏返回 ${missing.join(',')}`) }
    }
  }
  if (Array.isArray(expect.mustExclude)) {
    const bad = expect.mustExclude.filter((id) => set.has(id))
    if (bad.length) { ok = false; reasons.push(`不应返回 ${bad.join(',')}`) }
  }
  if (Array.isArray(expect.mustInclude)) {
    const missing = expect.mustInclude.filter((id) => !set.has(id))
    if (missing.length) { ok = false; reasons.push(`漏返回 ${missing.join(',')}`) }
  }
  if (ok) pass++; else failures.push({ id: c.caseId, cat: c.category, q: c.query.slice(0, 50), reasons })
  const cat = c.category ?? '(未分类)'
  const cur = byCat.get(cat) ?? { pass: 0, total: 0 }
  cur.total++; if (ok) cur.pass++
  byCat.set(cat, cur)
}
child.kill()

const pct = (100 * pass / total).toFixed(1)
const byCategory = [...byCat.entries()].sort((a, b) => b[1].total - a[1].total)
  .map(([cat, v]) => ({ cat, pass: v.pass, total: v.total }))
const out = { data: DATA, alias: USE_ALIAS, scope: USE_SCOPE, limit: LIMIT, pass, total, pct: Number(pct), by_category: byCategory,
  failures: failures.slice(0, 20) }
console.log(`\n=== 结果：${pass} / ${total} = ${pct}%（alias=${USE_ALIAS} scope=${USE_SCOPE} limit=${LIMIT}） ===\n`)
for (const c of byCategory) console.log(`  ${String(c.pass).padStart(2)}/${String(c.total).padStart(2)}  ${c.cat}`)
if (failures.length) {
  console.log(`\n失败 ${failures.length} 例（前 6）：`)
  for (const f of failures.slice(0, 6)) console.log(`  - [${f.cat}] ${f.q}\n      ${f.reasons.join(' | ')}`)
}
const jsonOut = get('json-out', null)
if (jsonOut) { writeFileSync(jsonOut, JSON.stringify(out, null, 1)); console.log(`\n结果已写 ${jsonOut}`) }
if (stderr.trim()) console.error('server stderr:', stderr.trim().slice(0, 300))
