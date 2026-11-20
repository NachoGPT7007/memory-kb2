#!/usr/bin/env node
// 归纳：从重抽结果里找旧原子的共同点
//
// 输入：experiment-rextract-atoms.mjs 产出的 JSONL
// 输出（对应「归纳出相同点」的要求）：
//   1) 逐卡坏率对照（旧 → 新）
//   2) 旧原子的问题类型分布（按 classifyAtom 的 reasons）
//   3) 长度 / nature / 具体性（含数字、路径、版本号）的新旧对比
//   4) 新旧配对模式：拆开、合并、替换、消失——用字符 bigram 相似度匹配
//
// 只读 JSONL，不碰 vault。

import { readFileSync } from 'node:fs'

const FILE = process.argv[2] || '/tmp/kb2-rextract-all.jsonl'
const rows = readFileSync(FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))

// ---- 工具 ----
const bigrams = (s) => {
  const c = String(s).replace(/[\s#*_`|[\]()（）\-—・、，。：；！？,.!?:;]/g, '').toLowerCase()
  const out = new Set()
  for (let i = 0; i < c.length - 1; i++) out.add(c.slice(i, i + 2))
  if (c.length === 1) out.add(c)
  return out
}
const sim = (a, b) => {
  const ba = bigrams(a), bb = bigrams(b)
  if (!ba.size || !bb.size) return 0
  let inter = 0
  for (const g of ba) if (bb.has(g)) inter++
  return inter / (ba.size + bb.size - inter)
}
const len = (s) => [...String(s)].length
const hasConcrete = (s) => /\d|https?:|\/[\w.-]+|\.[a-z]{2,5}\b|[A-Z]{2,}/.test(String(s))

// ---- 1) 逐卡对照 ----
const usable = rows.filter((r) => r.new.n > 0)
console.log(`卡数 ${rows.length}，其中成功重抽 ${usable.length} 张（${rows.length - usable.length} 张模型判无可提炼）\n`)

const oldN = rows.reduce((s, r) => s + r.old.n, 0), oldBad = rows.reduce((s, r) => s + r.old.bad, 0)
const newN = usable.reduce((s, r) => s + r.new.n, 0), newBad = usable.reduce((s, r) => s + r.new.bad, 0)
const oldNOnUsable = usable.reduce((s, r) => s + r.old.n, 0), oldBadOnUsable = usable.reduce((s, r) => s + r.old.bad, 0)

const pct = (n, d) => (d ? (n / d * 100).toFixed(1) : '0.0')
console.log('=== 汇总 ===')
console.log(`旧原子（全部 ${rows.length} 卡）:  ${oldN} 条，不合格 ${oldBad}（${pct(oldBad, oldN)}%）`)
console.log(`旧原子（可重抽的 ${usable.length} 卡）: ${oldNOnUsable} 条，不合格 ${oldBadOnUsable}（${pct(oldBadOnUsable, oldNOnUsable)}%）`)
console.log(`重抽后新原子:                ${newN} 条，不合格 ${newBad}（${pct(newBad, newN)}%）`)
console.log(`原子条数变化: ${oldNOnUsable} → ${newN}（${newN >= oldNOnUsable ? '+' : ''}${newN - oldNOnUsable}）`)

// ---- 2) 旧原子问题类型 ----
const reasonCount = new Map()
let oldBadAtoms = 0
for (const r of rows) for (const a of r.old.atoms) {
  if (a.verdict === 'pass') continue
  oldBadAtoms++
  for (const rs of a.reasons) {
    const k = String(rs).replace(/\(.*\)/, '')
    reasonCount.set(k, (reasonCount.get(k) || 0) + 1)
  }
}
console.log(`\n=== 旧原子问题类型（不合格 ${oldBadAtoms} 条，一条可命中多条）===`)
for (const [k, v] of [...reasonCount.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(20)} ${String(v).padStart(4)}  ${pct(v, oldBadAtoms)}%`)
}

// ---- 3) 长度 / nature / 具体性 ----
const med = (arr) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0 }
const oldLens = [], newLens = [], oldNat = {}, newNat = {}
let oldConcrete = 0, newConcrete = 0
for (const r of usable) {
  for (const a of r.old.atoms) { oldLens.push(len(a.text)); oldNat[a.nature] = (oldNat[a.nature] || 0) + 1; if (hasConcrete(a.text)) oldConcrete++ }
  for (const a of r.new.atoms) { newLens.push(len(a.text)); newNat[a.nature] = (newNat[a.nature] || 0) + 1; if (hasConcrete(a.text)) newConcrete++ }
}
console.log('\n=== 旧 vs 新 的形态 ===')
console.log(`长度中位数:    旧 ${med(oldLens)} 字   →  新 ${med(newLens)} 字`)
console.log(`长度 p90:      旧 ${[...oldLens].sort((a, b) => a - b)[Math.floor(oldLens.length * 0.9)]} 字   →  新 ${[...newLens].sort((a, b) => a - b)[Math.floor(newLens.length * 0.9)]} 字`)
console.log(`含具体值(数字/路径/版本): 旧 ${pct(oldConcrete, oldLens.length)}%  →  新 ${pct(newConcrete, newLens.length)}%`)
console.log(`nature 旧: ${JSON.stringify(oldNat)}`)
console.log(`nature 新: ${JSON.stringify(newNat)}`)

// ---- 4) 配对模式 ----
const pairs = { replaced: [], split: [], merged: [], vanished: [], added: [] }
for (const r of usable) {
  const olds = r.old.atoms.map((a) => ({ ...a, used: false }))
  const news = r.new.atoms.map((a) => ({ ...a, used: false }))
  // 每条新原子找最像的旧原子（>0.35 视为同源）
  for (const n of news) {
    let best = null, bestS = 0
    for (const o of olds) {
      if (o.used) continue
      const s = sim(o.text, n.text)
      if (s > bestS) { bestS = s; best = o }
    }
    if (best && bestS >= 0.35) { best.used = true; n.used = true; n._pair = best; n._sim = bestS }
  }
  const matchedOld = new Set(news.filter((n) => n._pair).map((n) => n._pair))
  // 同一条旧原子被多条新原子认领 = 拆分
  const claim = new Map()
  for (const n of news) if (n._pair) { claim.set(n._pair, (claim.get(n._pair) || 0) + 1) }
  for (const [o, c] of claim) if (c > 1) pairs.split.push({ path: r.path, old: o.text, n: c })
  // 旧原子无人认领
  for (const o of olds) if (!matchedOld.has(o)) pairs.vanished.push({ path: r.path, text: o.text, verdict: o.verdict, reasons: o.reasons })
  // 新原子无来源
  for (const n of news) if (!n._pair) pairs.added.push({ path: r.path, text: n.text, nature: n.nature })
  // 一对一替换且旧原子不合格
  for (const n of news) if (n._pair && claim.get(n._pair) === 1 && n._pair.verdict !== 'pass') {
    pairs.replaced.push({ path: r.path, old: n._pair.text, oldR: n._pair.reasons, neu: n.text })
  }
}

console.log('\n=== 新旧配对模式 ===')
console.log(`  一对一替换（旧原子不合格 → 新写法）: ${pairs.replaced.length}`)
console.log(`  一条旧原子被拆成多条:               ${pairs.split.length} 处`)
console.log(`  旧原子在新结果里找不到对应:         ${pairs.vanished.length} 条（其中不合格 ${pairs.vanished.filter((v) => v.verdict !== 'pass').length}）`)
console.log(`  新原子没有旧对应（新增判断）:       ${pairs.added.length} 条`)

const show = (arr, f, n = 6) => arr.slice(0, n).forEach((x) => console.log(f(x)))

if (pairs.replaced.length) {
  console.log('\n替换样本（旧 → 新）:')
  show(pairs.replaced, (p) => `  [${p.oldR.join(',')}]\n    旧：${String(p.old).slice(0, 76)}\n    新：${String(p.neu).slice(0, 76)}`)
}

console.log('\n消失样本（旧原子在新结果里没有对应）:')
show(pairs.vanished, (v) => `  [${v.verdict}] ${String(v.text).slice(0, 86)}`)

console.log('\n新增样本（模型补出的判断）:')
show(pairs.added, (a) => `  [${a.nature}] ${String(a.text).slice(0, 86)}`)
