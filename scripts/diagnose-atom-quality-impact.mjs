#!/usr/bin/env node
// 诊断：质量不合格的原子，会不会真的出现在用户看到的「依据」里
//
// 只读。不改任何卡片、不改索引。
//
// 口径（尽量贴近生产）：
//   1) 查询取自真实召回账本 memory-recall-ledger.jsonl（生产输入，不是自造）
//   2) 检索走 hybridQuery + 查询向量（与生产同一条链路）
//   3) 「依据」的模拟方式与 src/server.mjs 一致：该卡的原子按 boundary→fact→state→plan
//      排序后取前 6 条（NATURE_TAG 那一套）
//   4) 质量判定复用 scripts/audit-atoms.mjs 的 classifyAtom（同一条规则，不另写一份）
//
// 注意：账本唯一查询 44 条，未达 50 条的定结论门槛。这里只作观察。

import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { resolveVault, resolveDbPath } from '../src/paths.mjs'
import { classifyAtom } from './audit-atoms.mjs'

const LEDGER = process.env.MEM_LEDGER || path.join(path.dirname(resolveVault()), 'memory-recall-ledger.jsonl')
const VAULT = resolveVault()
const DB = resolveDbPath(VAULT)
const TOPK = 3
const CHAIN = 6

const idx = await import('../src/index.mjs')
const { embedOne } = await import('../src/embed-api.mjs')

let lines
try { lines = readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean) } catch (e) {
  console.error(`读不到账本：${LEDGER}\n${e.message}`)
  process.exit(2)
}
const queries = [...new Set(lines.map((l) => { try { return JSON.parse(l).query } catch { return null } }).filter(Boolean))]
console.log(`账本 ${lines.length} 行，唯一查询 ${queries.length} 条${queries.length < 50 ? '（未达 50 条门槛，只作观察）' : ''}\n`)

const db = new DatabaseSync(DB, { readOnly: true })
const atomStmt = db.prepare(`
  SELECT text, nature FROM atoms
  WHERE card_id = ? AND active = 1 AND nature NOT IN ('title','body')
`)

const NATURE_ORDER = { boundary: 0, fact: 1, state: 2, plan: 3, preference: 4 }
let totalQueries = 0
let queriesWithBadChain = 0
let totalChainAtoms = 0
let badChainAtoms = 0
const badSamples = []
let failed = 0

for (const q of queries) {
  let qvec = null
  try { qvec = await embedOne(q) } catch { qvec = null }
  let ranked
  try {
    const r = qvec
      ? idx.hybridQuery(q, { limit: TOPK, qvec })
      : idx.query(q, { limit: TOPK })
    ranked = r.ranked
  } catch (e) {
    failed++
    continue
  }
  if (!ranked?.length) continue
  totalQueries++

  const cid = (p) => require_hash(p)
  let thisQueryHasBad = false
  for (const card of ranked) {
    const id = cardIdOf(card.path)
    if (!id) continue
    const atoms = atomStmt.all(id)
      .sort((a, b) => (NATURE_ORDER[a.nature] ?? 9) - (NATURE_ORDER[b.nature] ?? 9))
      .slice(0, CHAIN)
    for (const a of atoms) {
      totalChainAtoms++
      const { verdict } = classifyAtom(a.text, { nature: a.nature })
      if (verdict !== 'pass') {
        badChainAtoms++
        thisQueryHasBad = true
        if (badSamples.length < 8) badSamples.push({ q, text: a.text, nature: a.nature, path: card.path, verdict })
      }
    }
  }
  if (thisQueryHasBad) queriesWithBadChain++
}

// 卡片 id 与 path 的映射（与 index.mjs 一致：sha1(rel).slice(0,12)）
import crypto from 'node:crypto'
function require_hash(rel) { return crypto.createHash('sha1').update(rel).digest('hex').slice(0, 12) }
function cardIdOf(rel) { return rel ? require_hash(rel) : null }

db.close()

const pct = (n, d) => (d ? (n / d * 100).toFixed(1) : '0.0')
console.log(`有效查询：${totalQueries} 条${failed ? `（${failed} 条检索或向量失败已跳过）` : ''}`)
console.log(`进到「依据」里的原子：${totalChainAtoms} 条`)
console.log(`其中质量不合格：${badChainAtoms} 条（${pct(badChainAtoms, totalChainAtoms)}%）`)
console.log(`含至少一条不合格依据的查询：${queriesWithBadChain} / ${totalQueries}（${pct(queriesWithBadChain, totalQueries)}%）`)

if (badSamples.length) {
  console.log('\n样本（查询 → 依据原文）：')
  for (const s of badSamples) {
    console.log(`  「${s.q}」`)
    console.log(`    [${s.verdict}] ${String(s.text).slice(0, 80)}`)
    console.log(`    ${s.path}`)
  }
}

// 说明数据边界，避免被当成结论
console.log(`\n数据边界：查询 ${totalQueries} 条${totalQueries < 50 ? '，未达 50 条门槛' : ''}；账本只记录了被试过的查询，不代表全部分布。`)
process.exit(0)
