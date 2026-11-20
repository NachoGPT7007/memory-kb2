#!/usr/bin/env node
// #2 验证：查询向量超时 30s → 5s
// 四个断言：
//   1) 默认值已是 5s（embed / rerank / post）
//   2) 超时参数确实生效（1ms 必然触发，且快速返回）
//   3) 真实往返远低于 5s（10 次实测 p50 与 max）
//   4) 索引批量路径显式放宽，不受查询默认影响（源码级断言）
//
// 需要 ALI_API_KEY 可达（$DSH_HOME/.credentials.yaml）。不可达时跳过 2/3 并标 SKIP。

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(here, '..')

const checks = []
let pass = 0, skipped = 0
const ok = (name, cond, extra = '') => {
  checks.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (cond) pass++
}
const skip = (name, why) => { checks.push(`SKIP  ${name}  (${why})`); skipped++ }

const src = readFileSync(path.join(ROOT, 'src/embed-api.mjs'), 'utf8')
const idx = readFileSync(path.join(ROOT, 'vendor/embed/sync-index.mjs'), 'utf8')

// 1) 默认值
ok('embed 默认 5s', /export async function embed\(texts, \{ timeoutMs = 5_000/.test(src))
ok('rerank 默认 5s', /export async function rerank\([^)]*timeoutMs = 5_000/.test(src))
ok('post 兜底默认 5s', /async function post\([^)]*timeoutMs = 5_000/.test(src))
ok('不再有 30_000 作为查询默认', !/export async function embed\(texts, \{ timeoutMs = 30_000/.test(src))

// 4) 索引路径显式放宽
ok('索引批量显式 30s', /embed\(batch\.map\(\(r\) => r\.text\), \{ timeoutMs: 30_000, retries: 1 \}\)/.test(idx))

// 2)+3) 真实调用
const { embedOne, rerank, apiStatus } = await import(path.join(ROOT, 'src/embed-api.mjs'))
if (!apiStatus().hasKey) {
  skip('超时参数生效', 'API key 不可达')
  skip('真实往返远低于 5s', 'API key 不可达')
} else {
  const t1 = Date.now()
  let aborted = false
  try { await embedOne('超时测试', { timeoutMs: 1 }) } catch { aborted = true }
  const dt1 = Date.now() - t1
  ok('超时参数生效', aborted && dt1 < 3000, `aborted=${aborted} ${dt1}ms`)

  const lat = []
  for (let i = 0; i < 10; i++) {
    const t = Date.now()
    await embedOne(`查询向量延迟实测 ${i}`)
    lat.push(Date.now() - t)
  }
  const sorted = [...lat].sort((a, b) => a - b)
  const p50 = sorted[5], max = sorted[9]
  ok('真实往返远低于 5s', max < 5000, `p50=${p50}ms max=${max}ms 余量=${(5000 / max).toFixed(1)}×`)

  const t2 = Date.now()
  const r = await rerank('记忆库', ['记忆库测试甲', '完全无关的乙'], { topN: 2 })
  ok('rerank 5s 内完成', r.length === 2 && Date.now() - t2 < 5000, `${Date.now() - t2}ms`)
}

console.log(checks.join('\n'))
console.log(`\n${pass}/${checks.length - skipped} 通过${skipped ? `，${skipped} 项跳过` : ''}`)
process.exit(pass === checks.length - skipped ? 0 : 1)
