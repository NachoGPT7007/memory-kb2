#!/usr/bin/env node
// #1 验证：写入设置校验（schema / tokenizer / embedModel / embedDim）
// 四个断言：
//   1) build 后在 meta 表登记 write_settings
//   2) 设置一致时 sync 不重建（走增量）
//   3) tokenizer 变了 → sync 明确报差异并全量重建，产出 rebuiltReason
//   4) 老库（无登记）→ 回填一次，不重建

import { promises as fs } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const here = path.dirname(fileURLToPath(import.meta.url))
const INDEX = path.join(here, '..', 'src', 'index.mjs')
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'kb2-t1-'))
const vault = path.join(tmp, 'vault')

const card = (n) => `---
formatVersion: 2
kind: knowledge
title: 测试卡${n}
tags: [t1]
created: 2026-11-21T00:00:00.000Z
updated: 2026-11-21T00:00:00.000Z
status: approved
source: test
atoms:
  - id: a${n}
    text: 这是第${n}张测试卡的一条判断内容，用于验证写入设置校验
    nature: fact
    subject: test
    evidence: ""
    active: true
    conf: 0.6
    labels: [t1]
---
# 测试卡${n}

这是第${n}张测试卡的正文内容，需要足够长度以便分词。
`

const checks = []
let pass = 0
const ok = (name, cond, extra = '') => {
  checks.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (cond) pass++
}

await fs.mkdir(path.join(vault, '03-Knowledge'), { recursive: true })
for (const n of [1, 2, 3]) await fs.writeFile(path.join(vault, '03-Knowledge', `测试卡${n}.md`), card(n), 'utf8')

// 从真源读 SCHEMA_ID：断言写死版本号会在每次 schema 升级时误报（2026-11-21 已踩一次）
const { SCHEMA_ID } = await import(path.join('..', 'src', 'index.mjs'))

const env = (extra = {}) => ({ ...process.env, MEM_VAULT: vault, ...extra })

// 用子进程跑，因为 TOKENIZER / EMBED_MODEL 是模块加载时读取的常量
const run = (action, extra = {}) => {
  const code = `import { sync, build } from ${JSON.stringify(INDEX)}; const r = ${action === 'build' ? 'await build()' : 'await sync()'}; console.log('RESULT=' + JSON.stringify(r))`
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: env(extra), encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`子进程失败: ${r.stderr || r.stdout}`)
  const line = r.stdout.split('\n').find((l) => l.startsWith('RESULT='))
  return { out: r.stdout, result: JSON.parse(line.slice(7)) }
}

const readMeta = () => {
  const db = new DatabaseSync(path.join(vault, '.index', 'memory.sqlite'))
  const row = db.prepare("SELECT v FROM meta WHERE k='write_settings'").get()
  db.close()
  return row?.v ? JSON.parse(row.v) : null
}

// 1) build 登记
run('build')
const ws = readMeta()
ok('build 后登记 write_settings', Boolean(ws), JSON.stringify(ws))
ok('登记含 tokenizer', ws?.tokenizer === 'regex', ws?.tokenizer)
ok('登记含 schema', ws?.schema === SCHEMA_ID, `${ws?.schema} vs ${SCHEMA_ID}`)
ok('登记含向量模型与维度', ws?.embedModel && Number(ws?.embedDim) === 1024, `${ws?.embedModel}/${ws?.embedDim}`)

// 2) 一致时不重建
const r2 = run('sync')
ok('设置一致 → 不走全量重建', !r2.result.fullBuild, `fullBuild=${r2.result.fullBuild}`)
ok('设置一致 → 没有 rebuiltReason', !r2.result.rebuiltReason)

// 3) tokenizer 变化 → 全量重建
const r3 = run('sync', { MEM_TOKENIZER: 'ws' })
ok('tokenizer 变化 → 全量重建', r3.result.fullBuild === true, String(r3.result.fullBuild))
ok('rebuiltReason 写明差异', /write-settings/.test(r3.result.rebuiltReason || '') && /regex → ws/.test(r3.result.rebuiltReason || ''), r3.result.rebuiltReason)
ok('重建后登记已更新为 ws', readMeta()?.tokenizer === 'ws', readMeta()?.tokenizer)
ok('重建日志可见', /写入设置与索引不一致/.test(r3.out))

// 4) 老库无登记 → 回填，不重建
const db = new DatabaseSync(path.join(vault, '.index', 'memory.sqlite'))
db.prepare("DELETE FROM meta WHERE k='write_settings'").run()
db.close()
ok('已移除登记（模拟老库）', readMeta() === null)
const r4 = run('sync')
ok('无登记 → 不重建', !r4.result.fullBuild, `fullBuild=${r4.result.fullBuild}`)
ok('无登记 → 回填成功', readMeta()?.tokenizer === 'regex', JSON.stringify(readMeta()))
ok('回填日志说明无法回溯', /历史设置无法回溯/.test(r4.out))

console.log(checks.join('\n'))
console.log(`\n${pass}/${checks.length} 通过`)
await fs.rm(tmp, { recursive: true, force: true })
process.exit(pass === checks.length ? 0 : 1)
