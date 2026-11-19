#!/usr/bin/env node
/**
 * kb2-selfcheck.mjs — kb2 本体体检（一条命令，可重复跑，不用记「上次是好的」）。
 *
 * 查五件事：
 *   1. 索引完整性：卡数 / 非 title 原子数 / 向量条数，三者对不上就是索引半成品
 *   2. 归档卡规模（status: deleted，默认不进结果，但占语料）
 *   3. 结果不变量：候选池 5/20/80 下前 5 名必须一致（第 19 轮实测 64/64）
 *   4. 延迟构成：BM25 / 向量 / 全表读 / 融合 / 一次 embedding 往返各占多少
 *   5. --serve 时跑工程库人工标注，出服务层 top1/top3（真实 MCP 往返）
 *
 * 用法：
 *   node scripts/kb2-selfcheck.mjs --vault /tmp/probe-vault
 *   node scripts/kb2-selfcheck.mjs --vault <副本> --serve
 * 退出码：0 全通过；1 有 FAIL；2 有 WARN 但无 FAIL。
 *
 * 注意：--serve 会让服务做 ensureFresh（可能重建索引），只对副本用，不要指向生产库。
 */
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const ROOT = path.join(HERE, '..')
const argv = process.argv.slice(2)
const get = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d }
const VAULT = get('vault') || process.env.MEM_VAULT
const SERVE = argv.includes('--serve')
const CASES = path.join(ROOT, 'bench/chat-memory-benchmark-2.2/adapters/cases_engineering.json')
const REAL = process.env.MEM_VAULT || path.join(os.homedir(), '.memory-vault')

if (!VAULT) { console.error('用法：node scripts/kb2-selfcheck.mjs --vault <库路径> [--serve]'); process.exit(1) }
const DB = path.join(VAULT, '.index', 'memory.sqlite')
const results = []
const add = (level, name, detail) => results.push({ level, name, detail })

if (!existsSync(DB)) { console.error(`索引不存在：${DB}（先跑 node scripts/memory-index.mjs --build）`); process.exit(1) }
if (path.resolve(VAULT) === path.resolve(REAL)) {
  add('INFO', '库类型', '生产库：只做只读检查，--serve 已忽略')
}

// ---------------------------------------------------------------- 1+2 索引完整性
const db = new DatabaseSync(DB, { readOnly: true })
const cards = db.prepare('SELECT COUNT(*) c FROM cards').get().c
const deleted = db.prepare("SELECT COUNT(*) c FROM cards WHERE COALESCE(status,'')='deleted'").get().c
const atoms = db.prepare("SELECT COUNT(*) c FROM atoms WHERE nature != 'title'").get().c
let vec = 0, dim = 0
try { const v = JSON.parse(readFileSync(path.join(VAULT, '.index', 'vectors.json'), 'utf8')); vec = v.count || 0; dim = v.dim || 0 } catch {}
db.close()

add('INFO', '语料规模', `${cards} 卡 / ${atoms} 非 title 原子 / 归档 ${deleted} 张（${(100 * deleted / (cards || 1)).toFixed(1)}%）`)
if (!vec) add('WARN', '向量', 'vectors.json 缺失或为空 → 检索只能走 BM25')
else if (vec < atoms * 0.95) add('FAIL', '向量', `向量 ${vec} 条 < 原子 ${atoms} 条的 95%，向量路会大量缺卡`)
else add('PASS', '向量', `${vec} 条，dim ${dim}`)

// ---------------------------------------------------------------- 3 候选池不变量
const mod = await import(path.join(ROOT, 'scripts/memory-index.mjs'))
let qv = null
try {
  const api = await import(path.join(ROOT, 'mcp/embed-api.mjs'))
  qv = await api.embedOne('记忆库混合检索评测')
} catch { /* 无 key 时跳过向量路 */ }
const probes = ['记忆库混合检索评测', '火绒误报排查', '知识图谱卡死', '隧道存活看门狗']
let same = 0, total = 0
for (const q of probes) {
  const seqs = [5, 20, 80].map((n) => (qv
    ? mod.hybridQuery(q, { limit: n, qvec: qv, titleW: 3.0 })
    : mod.query(q, { limit: n, titleW: 3.0 })).ranked.slice(0, 5).map((c) => c.cardId).join('>'))
  total++
  if (new Set(seqs).size === 1) same++
}
add(same === total ? 'PASS' : 'FAIL', '候选池不变量',
  `${same}/${total} 条查询在池 5/20/80 下前 5 名一致${qv ? '' : '（无向量 key，走 BM25 单路）'}`)

// ---------------------------------------------------------------- 4 延迟构成
const t = () => Number(process.hrtime.bigint() / 1000n) / 1000
const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)]
const q0 = probes[0]
let a = []
for (let i = 0; i < 5; i++) { const t0 = t(); mod.query(q0, { limit: 200 }); a.push(t() - t0) }
const bm25 = +med(a).toFixed(1)
a = []
for (let i = 0; i < 5; i++) {
  const t0 = t()
  const d = new DatabaseSync(DB, { readOnly: true })
  d.prepare("SELECT id, card_id, text, nature FROM atoms WHERE nature != 'title'").all()
  d.prepare('SELECT id, path, title, kind FROM cards').all()
  d.close(); a.push(t() - t0)
}
const full = +med(a).toFixed(1)
let hybrid = null, embedMs = null
if (qv) {
  a = []
  for (let i = 0; i < 5; i++) { const t0 = t(); mod.hybridQuery(q0, { limit: 80, qvec: qv, titleW: 3.0 }); a.push(t() - t0) }
  hybrid = +med(a).toFixed(1)
  const api = await import(path.join(ROOT, 'mcp/embed-api.mjs'))
  a = []
  for (let i = 0; i < 3; i++) { const t0 = t(); await api.embedOne('隧道存活看门狗'); a.push(t() - t0) }
  embedMs = +med(a).toFixed(1)
}
add('INFO', '延迟构成', `BM25 ${bm25}ms / 全表读 ${full}ms / 融合 ${hybrid ?? '—'}ms / embedding 往返 ${embedMs ?? '—'}ms`)
if (hybrid != null && full > hybrid * 0.5) add('WARN', '全表读占比', `${full}ms 占融合 ${hybrid}ms 的 ${(100 * full / hybrid).toFixed(0)}%，可惰性化（只为 top 卡取原子文本）`)

// ---------------------------------------------------------------- 5 服务层准确率
function norm0(x) { return String(x || '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase() }
if (SERVE && path.resolve(VAULT) !== path.resolve(REAL) && existsSync(CASES)) {
  const casesAll = JSON.parse(readFileSync(CASES, 'utf8'))
  // 与基线同口径：目标卡已归档（status: deleted）的题不计入——那是标注过期，不是检索缺陷
  const db2 = new DatabaseSync(DB, { readOnly: true })
  const delTitles = new Set(db2.prepare("SELECT title FROM cards WHERE COALESCE(status,'')='deleted'").all().map((c) => norm0(c.title)))
  db2.close()
  const cases = casesAll.filter((c) => !c.aliases.some((a) => { const na = norm0(a); for (const t2 of delTitles) if (t2.includes(na) || na.includes(t2)) return true; return false }))
  add('INFO', '标注题', `${casesAll.length} 条中 ${cases.length} 条有效（排除目标卡已归档的 ${casesAll.length - cases.length} 条）`)
  const srv = spawn(process.execPath, [path.join(ROOT, 'mcp/memory-server.mjs')], {
    env: { ...process.env, MEM_VAULT: VAULT }, stdio: ['pipe', 'pipe', 'pipe'],
  })
  let buf = '', stderr = ''
  const pending = new Map()
  srv.stderr.on('data', (d) => { stderr += String(d) })
  srv.stdout.on('data', (d) => {
    buf += String(d)
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
      if (!line) continue
      let m; try { m = JSON.parse(line) } catch { continue }
      if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
    }
  })
  let id = 1
  const rpc = (method, params) => new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error(method + ' 超时')), 60000)
    pending.set(id, (m) => { clearTimeout(to); res(m) })
    srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }) + '\n')
  })
  const norm = (s) => String(s || '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()
  const bg = (x) => { const o = new Set(); for (let i = 0; i < x.length - 1; i++) o.add(x.slice(i, i + 2)); return o }
  const cover = (w, t2) => { const s2 = bg(w); if (!s2.size) return 0; let k = 0; for (const x of s2) if (t2.includes(x)) k++; return k / s2.size }
  const hit = (aliases, title) => aliases.some((w) => { const t2 = norm(title), nw = norm(w); return t2.includes(nw) || nw.includes(t2) || cover(nw, t2) >= 0.7 })
  let n = 0, top1 = 0, top3 = 0
  const lat = []
  try {
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'selfcheck', version: '1' } })
    srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    for (const c of cases) {
      const t0 = t()
      const r = await rpc('tools/call', { name: 'memory_search', arguments: { query: c.q, limit: 5 } })
      lat.push(t() - t0)
      const text = (r.result?.content || []).map((x) => x.text || '').join('\n')
      const titles = [...text.matchAll(/^### \d+\. (.+?)(?: \[[\d.]+\])?$/gm)].map((m) => m[1])
      if (!titles.length) continue
      n++
      if (hit(c.aliases, titles[0])) top1++
      if (titles.slice(0, 3).some((x) => hit(c.aliases, x))) top3++
    }
  } finally { srv.kill() }
  lat.sort((x, y) => x - y)
  const p = (f) => lat[Math.min(lat.length - 1, Math.floor(lat.length * f))] || 0
  // 基线：2026-11-14 工程库 59 条有效题 top1 93.2% / top3 100%
  const p1 = 100 * top1 / (n || 1), p3 = 100 * top3 / (n || 1)
  add(p3 >= 97 && p1 >= 88 ? 'PASS' : 'WARN', '服务层准确率',
    `top1 ${p1.toFixed(1)}% / top3 ${p3.toFixed(1)}%（n=${n}，已排除归档卡题；基线 93.2/100）p50 ${p(0.5).toFixed(0)}ms p95 ${p(0.95).toFixed(0)}ms`)
  if (stderr.trim()) add('WARN', '服务端 stderr', stderr.trim().slice(0, 200))
} else if (SERVE) {
  add('WARN', '服务层准确率', '跳过：生产库不跑 --serve，或标注文件缺失')
}

// ---------------------------------------------------------------- 输出
const order = { FAIL: 0, WARN: 1, PASS: 2, INFO: 3 }
results.sort((x, y) => order[x.level] - order[y.level])
for (const r of results) console.log(`${r.level.padEnd(4)} ${r.name}：${r.detail}`)
const fail = results.filter((r) => r.level === 'FAIL').length
const warn = results.filter((r) => r.level === 'WARN').length
console.log(`\n${fail ? 'FAIL' : warn ? 'WARN' : 'PASS'} —— ${VAULT}`)
process.exit(fail ? 1 : warn ? 2 : 0)
