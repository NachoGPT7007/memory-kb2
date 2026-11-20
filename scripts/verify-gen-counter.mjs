#!/usr/bin/env node
// 世代/签名计数器 · 接线验证（区别于 eval 脚本：这里验的是「索引与签名是否同步更新」）
//
// 断言：
//   1) build 后生成签名，且与磁盘一致
//   2) 无变化 sync 后签名不变
//   3) 加卡 sync 后签名变化，且与磁盘一致
//   4) 删卡 sync 后签名变化，count 减少（旧的时间戳逻辑在这里会漏判）
//   5) 索引记录的签名 ≠ 磁盘签名时，判定为 stale
//   6) 老索引（无签名文件）→ readSig 返回 null，判定 stale，sync 后补上

import { promises as fs } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const INDEX = path.join(here, '..', 'src', 'index.mjs')
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'kb2-gen2-'))
const vault = path.join(tmp, 'vault')
await fs.mkdir(path.join(vault, '03-Knowledge'), { recursive: true })

const { contentSignature, sigEquals, readSig, sigPath } = await import('../src/freshness.mjs')

const checks = []
let pass = 0
const ok = (name, cond, extra = '') => {
  checks.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (cond) pass++
}

const card = (n) => `---
formatVersion: 2
kind: knowledge
title: 签名卡${n}
tags: [sig]
created: 2026-11-21T00:00:00.000Z
updated: 2026-11-21T00:00:00.000Z
status: approved
---
# 签名卡${n}

正文内容第 ${n} 张，长度足够。
`
const run = (action) => {
  const code = `import { sync, build } from ${JSON.stringify(INDEX)}; const r = ${action === 'build' ? 'await build()' : 'await sync()'}; console.log('RESULT=' + JSON.stringify(r))`
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, MEM_VAULT: vault }, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(r.stderr || r.stdout)
  return JSON.parse(r.stdout.split('\n').find((l) => l.startsWith('RESULT=')).slice(7))
}

for (const n of [1, 2, 3]) await fs.writeFile(path.join(vault, '03-Knowledge', `卡${n}.md`), card(n), 'utf8')

// 1) build → 签名
run('build')
const s1 = await readSig(vault)
const d1 = await contentSignature(vault)
ok('build 后生成签名', Boolean(s1), JSON.stringify(s1))
ok('签名与磁盘一致', sigEquals(s1, d1))
ok('签名含纳秒级 mtime', typeof s1?.maxMtimeNs === 'string' && s1.maxMtimeNs.length > 10, s1?.maxMtimeNs)

// 2) 无变化 sync → 签名不变
run('sync')
const s2 = await readSig(vault)
ok('无变化 sync 后签名不变', sigEquals(s1, s2))

// 3) 加卡 → 签名变化
await new Promise((r) => setTimeout(r, 10))
await fs.writeFile(path.join(vault, '03-Knowledge', '卡4.md'), card(4), 'utf8')
run('sync')
const s3 = await readSig(vault)
const d3 = await contentSignature(vault)
ok('加卡后签名变化', !sigEquals(s2, s3))
ok('加卡后 count +1', Number(s3.count) === Number(s2.count) + 1, `${s2.count} → ${s3.count}`)
ok('加卡后签名与磁盘一致', sigEquals(s3, d3))

// 4) 删卡 → 签名变化（旧逻辑漏判的场景）
await new Promise((r) => setTimeout(r, 10))
await fs.unlink(path.join(vault, '03-Knowledge', '卡1.md'))
run('sync')
const s4 = await readSig(vault)
ok('删卡后签名变化', !sigEquals(s3, s4))
ok('删卡后 count -1', Number(s4.count) === Number(s3.count) - 1, `${s3.count} → ${s4.count}`)
ok('删卡后签名与磁盘一致', sigEquals(s4, await contentSignature(vault)))

// 5) 签名与磁盘不一致 → stale
await new Promise((r) => setTimeout(r, 10))
await fs.writeFile(path.join(vault, '03-Knowledge', '卡5.md'), card(5), 'utf8')
ok('磁盘多一张卡 → 判 stale', !sigEquals(await readSig(vault), await contentSignature(vault)))

// 6) 老索引：删掉签名文件
await fs.unlink(sigPath(vault))
ok('无签名文件 → readSig 返回 null', (await readSig(vault)) === null)
ok('无签名 → 判 stale', !sigEquals(await readSig(vault), await contentSignature(vault)))
run('sync')
ok('sync 后补上签名', Boolean(await readSig(vault)), JSON.stringify(await readSig(vault)))

console.log(checks.join('\n'))
console.log(`\n${pass}/${checks.length} 通过`)
await fs.rm(tmp, { recursive: true, force: true })
process.exit(pass === checks.length ? 0 : 1)
