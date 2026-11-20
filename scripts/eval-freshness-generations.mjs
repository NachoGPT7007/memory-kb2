#!/usr/bin/env node
// 世代计数器评测（第一版：只测基线，不改生产）
//
// 目的：在动手把「STAMP 时间戳」换成「内容签名 + 世代计数器」之前，
// 先用同一批输入量出旧逻辑的误判率，作为对照组。
//
// 对照的两种判定：
//   A 现逻辑（复刻自 src/server.mjs:289-320 ensureFresh 的核心，省略 60 秒缓存）：
//       lastSync = STAMP 文件里的 Date.now()
//       stale    = maxCardMtime > lastSync
//   B 候选逻辑（内容签名）：
//       磁盘侧 sig = { count, maxMtime, totalBytes }（全部来自文件系统属性）
//       索引侧 sig = 上次 sync 时记下的同一结构
//       stale      = 两侧不相等
//
// 期望成立的三条：
//   1) 删卡时 A 漏判（只看 max mtime，删卡不会抬高 mtime）→ B 应判出
//   2) 文件 mtime 早于 stamp（复制/解包/时钟回拨）时 A 漏判 → B 应判出
//   3) 无变化时两者都不应误报
//
// 样本：6 类场景 × 每类 10 次 = 60 次判定（满足「样本量不到 50 不定结论」）。

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// 用生产实现而不是复刻：评测输入必须与生产一致（HANDOFF.md §1.3）。
// 复刻版只在早期用来量基线，一旦有了 src/freshness.mjs 就换成真代码。
import { contentSignature, sigEquals } from '../src/freshness.mjs'

const N_PER_CLASS = 10
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'kb2-gen-'))
const vault = path.join(tmp, 'vault')
await fs.mkdir(path.join(vault, '03-Knowledge'), { recursive: true })

const cardText = (i) => `---
formatVersion: 2
kind: knowledge
title: 签名测试卡${i}
tags: [sig]
created: 2026-11-21T00:00:00.000Z
updated: 2026-11-21T00:00:00.000Z
status: approved
---
# 签名测试卡${i}

这是第 ${i} 张测试卡的正文，长度够用来算签名。
`

// ---- 两种判定 ----

/** 复刻 server.mjs ensureFresh 的核心：只比 maxMtime 与 stamp 时间戳。 */
async function newestMtime(dir, acc = { t: 0 }) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (!['.git', '.index', 'node_modules'].includes(e.name)) await newestMtime(p, acc) }
    else if (e.name.endsWith('.md')) { const st = await fs.stat(p); if (st.mtimeMs > acc.t) acc.t = st.mtimeMs }
  }
  return acc
}
const judgeLegacy = async (stampMs) => (await newestMtime(vault)).t > stampMs

/** 候选：内容签名，两侧都来自文件系统属性，不掺 Date.now()。 */
// 生产实现：src/freshness.mjs 的 contentSignature / sigEquals
const judgeSig = async (indexedSig) => !sigEquals(indexedSig, await contentSignature(vault))

// ---- 场景 ----

const results = []
let cardSeq = 0
const writeCard = async (i) => {
  cardSeq++
  await fs.writeFile(path.join(vault, '03-Knowledge', `卡${i}.md`), cardText(cardSeq), 'utf8')
}
// 建立初始 5 张卡
for (let i = 1; i <= 5; i++) await writeCard(i)

const scenarios = {
  'no-change': async () => {},
  'add-card': async (k) => { await writeCard(100 + k) },
  'modify-card': async (k) => {
    // 内容变化 + mtime 推进（真实编辑）
    await fs.writeFile(path.join(vault, '03-Knowledge/卡1.md'), cardText(cardSeq + 500 + k), 'utf8')
  },
  'delete-card': async () => {
    const files = await fs.readdir(path.join(vault, '03-Knowledge'))
    const victim = files.filter((f) => f.endsWith('.md'))[0]
    await fs.unlink(path.join(vault, '03-Knowledge', victim))
  },
  'mtime-in-past': async (k) => {
    // 复制/解包/时钟回拨：内容变了但 mtime 比 stamp 旧
    const f = path.join(vault, '03-Knowledge', `旧时${k}.md`)
    await fs.writeFile(f, cardText(cardSeq + 900 + k), 'utf8')
    const past = new Date(Date.now() - 86400_000)
    await fs.utimes(f, past, past)
  },
  'mtime-in-future': async (k) => {
    const f = path.join(vault, '03-Knowledge', `未来${k}.md`)
    await fs.writeFile(f, cardText(cardSeq + 1200 + k), 'utf8')
    const future = new Date(Date.now() + 3600_000)
    await fs.utimes(f, future, future)
  },
}

// 每类场景都要有「判定前的索引状态」：stamp + 内容签名
for (const [name, mutate] of Object.entries(scenarios)) {
  let legacyHit = 0, sigHit = 0
  for (let k = 0; k < N_PER_CLASS; k++) {
    // 复原到干净状态
    await fs.rm(vault, { recursive: true, force: true })
    await fs.mkdir(path.join(vault, '03-Knowledge'), { recursive: true })
    for (let i = 1; i <= 5; i++) await writeCard(i)
    // 「上一次 sync」的记录
    const stampMs = Date.now()
    const indexedSig = await contentSignature(vault)
    await fs.mkdir(path.join(vault, '.index'), { recursive: true })
    await fs.writeFile(path.join(vault, '.index', '.last-sync'), String(stampMs), 'utf8')
    // 制造变化。先等 5ms：生产里 sync 与下一次写卡之间隔的是分钟级，
    // 不留间隔会让「同一毫秒」掩盖真实行为（探测手段问题，不是被测对象问题）。
    await new Promise((r) => setTimeout(r, 5))
    await mutate(k)
    // 判定
    if (await judgeLegacy(stampMs)) legacyHit++
    if (await judgeSig(indexedSig)) sigHit++
  }
  results.push({ name, legacy: legacyHit / N_PER_CLASS, sig: sigHit / N_PER_CLASS })
}

// 期望：除 no-change / mtime-in-future 外，真实变化时都该判 stale
const expectStale = { 'no-change': false, 'add-card': true, 'modify-card': true, 'delete-card': true, 'mtime-in-past': true, 'mtime-in-future': true }

console.log(`场景 × ${N_PER_CLASS} 次，共 ${Object.keys(scenarios).length * N_PER_CLASS} 次判定\n`)
console.log('场景'.padEnd(18) + '应为'.padEnd(8) + '旧逻辑(stale率)'.padEnd(20) + '签名逻辑(stale率)')
let legacyWrong = 0, sigWrong = 0, total = 0
for (const r of results) {
  const want = expectStale[r.name]
  const legacyOk = (r.legacy === 1) === want
  const sigOk = (r.sig === 1) === want
  total += N_PER_CLASS
  if (!legacyOk) legacyWrong += N_PER_CLASS
  if (!sigOk) sigWrong += N_PER_CLASS
  console.log(
    r.name.padEnd(18) +
    String(want).padEnd(8) +
    `${r.legacy.toFixed(2)} ${legacyOk ? '✓' : '✗ 误判'}`.padEnd(20) +
    `${r.sig.toFixed(2)} ${sigOk ? '✓' : '✗ 误判'}`
  )
}
console.log(`\n误判：旧逻辑 ${legacyWrong}/${total} (${(legacyWrong / total * 100).toFixed(1)}%)，签名逻辑 ${sigWrong}/${total} (${(sigWrong / total * 100).toFixed(1)}%)`)

await fs.rm(tmp, { recursive: true, force: true })
process.exit(0)
