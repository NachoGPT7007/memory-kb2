#!/usr/bin/env node
/**
 * eval-engineering.mjs —— 工程档位检索评测（单用户库，人工标注 64 条）
 *
 * 口径（与 docs/BENCHMARK.md §3 一致）：
 *   - 64 条题全跑；其中目标卡已归档（status: deleted）的题不计入——那是标注过期，不是检索缺陷
 *   - 有效题 = 59 条；基线 top1 93.2% / top3 100%
 *   - 宽松判定（标注串二元组覆盖 ≥0.7）与严格判定（子串）都报
 *
 * 用法：
 *   node bench/eval-engineering.mjs <vault> [--limit 5] [--pool 0] [--vector 1] [--rerank 0]
 *   node bench/eval-engineering.mjs <vault> --json   # 只输出 JSON
 *
 * 注意：只对副本库跑。--serve 语义已内置（走真实 MCP stdio 往返），会触发 ensureFresh，
 * 不要指向生产库。
 */
import { spawn } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const argv = process.argv.slice(2)
const get = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d }
const VAULT = argv.find((a) => !a.startsWith('--') && !/^\d+$/.test(a) && a !== '0' && a !== '1')
if (!VAULT) { console.error('用法：node bench/eval-engineering.mjs <vault> [--limit 5] [--pool 0] [--vector 1] [--rerank 0]'); process.exit(2) }
const LIMIT = Number(get('limit', 5))
const POOL = String(get('pool', '0'))
const VECTOR = String(get('vector', '1'))
const RERANK = String(get('rerank', '0'))
const JSON_ONLY = argv.includes('--json')
const SERVER = process.env.EVAL_SERVER || path.join(ROOT, 'src/server.mjs')
const CASES = JSON.parse(readFileSync(path.join(HERE, 'cases-engineering.json'), 'utf8'))

const norm = (s) => String(s || '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()
const bg = (x) => { const o = new Set(); for (let i = 0; i < x.length - 1; i++) o.add(x.slice(i, i + 2)); return o }
const cover = (w, t) => { const a = bg(w); if (!a.size) return 0; let k = 0; for (const x of a) if (t.includes(x)) k++; return k / a.size }
const loose = (want, t) => want.some((w) => t.includes(w) || w.includes(t) || cover(w, t) >= 0.7)
const strict = (want, t) => want.some((w) => t.includes(w) || w.includes(t))

// ---- 归档题排除（与 scripts/selfcheck.mjs 同口径）
const DB = path.join(VAULT, '.index', 'memory.sqlite')
let delTitles = []
if (existsSync(DB)) {
  const db = new DatabaseSync(DB, { readOnly: true })
  delTitles = db.prepare("SELECT title FROM cards WHERE COALESCE(status,'')='deleted'").all().map((c) => norm(c.title))
  db.close()
}
const archived = (c) => c.aliases.some((a) => { const na = norm(a); return delTitles.some((t) => t.includes(na) || na.includes(t)) })

// ---- MCP stdio 往返
const env = { ...process.env, MEM_VAULT: VAULT, MEM_DEFAULT_LIMIT: String(LIMIT), MEM_VECTOR: VECTOR, MEM_RERANK: RERANK,
  ...(POOL !== '0' ? { MEM_POOL: POOL } : {}) }
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
  const to = setTimeout(() => rej(new Error(method + ' 超时')), 90000)
  pending.set(id, (m) => { clearTimeout(to); res(m) })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
})
const titles = (text) => [...text.matchAll(/^### \d+\. (.+?)(?: \[[\d.]+\])?$/gm)].map((m) => m[1])

await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'eval-eng', version: '1' } })
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
await rpc('tools/call', { name: 'memory_search', arguments: { query: '预热探针', limit: 1 } })

const rows = []
let modeLine = ''
for (const c of CASES) {
  const t0 = Date.now()
  let r
  try { r = await rpc('tools/call', { name: 'memory_search', arguments: { query: c.q, limit: LIMIT } }) }
  catch (e) { rows.push({ q: c.q, aliases: c.aliases, error: String(e.message).slice(0, 120) }); continue }
  const ms = Date.now() - t0
  const text = (r.result?.content || []).map((x) => x.text || '').join('\n')
  if (!modeLine) { const m = /检索到[^：]*：|engineering档[^）]*/.exec(text); modeLine = m ? m[0] : '' }
  rows.push({ q: c.q, aliases: c.aliases, ms, titles: titles(text), chars: text.length })
}
let stats = ''
try { const s = await rpc('tools/call', { name: 'memory_stats', arguments: {} }); stats = (s.result?.content || []).map((x) => x.text || '').join('\n') } catch {}
child.kill()

const okRows = rows.filter((r) => !r.error)
function score(list) {
  let t1 = 0, t3 = 0, t1s = 0, t3s = 0, n = 0
  for (const r of list) {
    const ts = (r.titles || []).map(norm)
    if (!ts.length) continue
    n++
    const want = r.aliases.map(norm)
    if (loose(want, ts[0])) t1++
    if (ts.slice(0, 3).some((x) => loose(want, x))) t3++
    if (strict(want, ts[0])) t1s++
    if (ts.slice(0, 3).some((x) => strict(want, x))) t3s++
  }
  return { n, top1: +(100 * t1 / n).toFixed(1), top3: +(100 * t3 / n).toFixed(1), top1_strict: +(100 * t1s / n).toFixed(1), top3_strict: +(100 * t3s / n).toFixed(1) }
}
const kept = okRows.filter((r) => !archived(r))
const lat = okRows.map((r) => r.ms).sort((a, b) => a - b)
const pct = (p) => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] || 0
const out = {
  vault: VAULT, config: { limit: LIMIT, pool: POOL === '0' ? 'adaptive' : POOL, vector: VECTOR, rerank: RERANK },
  cases: CASES.length, scored: okRows.length, excluded_archived: okRows.length - kept.length,
  mode: modeLine,
  all64: score(okRows), effective59: score(kept),
  ms_p50: pct(0.5), ms_p95: pct(0.95),
  errors: rows.filter((r) => r.error).map((r) => r.q),
  cache: (stats.match(/查询向量缓存[^\n]*/) || [''])[0],
  misses: okRows.filter((r) => !loose(r.aliases.map(norm), (r.titles[0] || '').length ? norm(r.titles[0]) : '')).map((r) => ({ q: r.q, want: r.aliases[0], got: r.titles[0] || '(空)' })),
}
if (!JSON_ONLY) {
  const e = out.effective59
  console.log(`库：${VAULT}  配置：limit ${LIMIT} / pool ${POOL === '0' ? '自适应' : POOL} / 向量 ${VECTOR} / rerank ${RERANK}`)
  console.log(`题：${out.cases} 条，有效 ${e.n} 条（排除目标卡已归档 ${out.excluded_archived} 条）`)
  console.log(`top1 ${e.top1}%  top3 ${e.top3}%（宽松）  |  严格 top1 ${e.top1_strict}% top3 ${e.top3_strict}%`)
  console.log(`64 条全量：top1 ${out.all64.top1}% / top3 ${out.all64.top3}%`)
  console.log(`延迟 p50 ${out.ms_p50} ms / p95 ${out.ms_p95} ms  ${out.cache}`)
  // 基线断言：允许 1 条题（59 条上 1.7pp）以内波动
  const pass = e.top1 >= 91.5 && e.top3 >= 98.3
  console.log(pass ? 'PASS —— 不劣于基线 93.2 / 100（容差 1 条题）' : 'FAIL —— 低于基线 93.2 / 100，需检查改动')
  if (!pass) process.exitCode = 1
}
if (argv.includes('--verbose')) console.log(JSON.stringify(out, null, 1))
if (stderr.trim()) console.error('server stderr:', stderr.trim().slice(0, 300))
if (argv.includes('--json-out')) {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(get('json-out', '/tmp/eval-engineering.json'), JSON.stringify(out, null, 1))
}
