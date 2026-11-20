#!/usr/bin/env node
/**
 * scripts/memory-index.mjs —— 兼容壳（2026-11-20）
 *
 * 为什么存在：仓库早期布局是 mcp/memory-server.mjs + scripts/memory-index.mjs，
 * 重构到 src/ 之后，server.mjs 里那句动态 import('../scripts/memory-index.mjs')
 * 变成了断链——`npm install` 之后 `node src/server.mjs` 仍然 ERR_MODULE_NOT_FOUND，
 * clone 下来跑不起来。本文件把旧路径接回 src/index.mjs，同时转发 CLI 参数。
 *
 * CLI 与原实现等价：--build | --query "..." [--limit 5] | --stats
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export * from '../src/index.mjs'
import { build, sync, query, openIndex } from '../src/index.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const isEntry = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(HERE, 'memory-index.mjs')

if (isEntry) {
  const argv = process.argv.slice(2)
  const get = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d }
  if (argv.includes('--build')) {
    const r = await build()
    console.log(`索引已建：${r.nCards} 卡 / ${r.nAtoms} 原子 / ${r.nPost} 倒排项，avgdl=${r.avg.toFixed(1)}`)
  } else if (argv.includes('--sync')) {
    // 增量：只处理新增/修改/删除的卡
    const r = await sync({ force: argv.includes('--force') })
    console.log(`索引已同步：新增 ${r.added} / 更新 ${r.updated} / 删除 ${r.deleted} / 跳过 ${r.skipped}（${r.ms} ms）`)
    console.log(`总计：${r.nCards} 卡 / ${r.nAtoms} 原子 / ${r.nPost} 倒排项，avgdl=${r.avg.toFixed(1)}`)
  } else if (argv.includes('--query')) {
    const q = get('query', '')
    const limit = Number(get('limit', 5))
    const { ranked, stats } = query(q, { limit })
    console.log(`查询「${q}」 切词 ${stats.terms} 个，候选原子 ${stats.candidateAtoms}/${stats.N}`)
    ranked.forEach((r, i) => console.log(`  ${i + 1}. [${r.score.toFixed(2)}] ${r.title.slice(0, 40)}`))
    if (!ranked.length) console.log('  无命中')
  } else if (argv.includes('--stats')) {
    const { db, N, avgdl } = openIndex()
    const c = db.prepare('SELECT COUNT(*) c FROM cards').get().c
    const p = db.prepare('SELECT COUNT(*) c FROM postings').get().c
    console.log(`卡 ${c} / 原子 ${N} / 倒排项 ${p} / avgdl ${avgdl.toFixed(1)}`)
    db.close()
  } else {
    console.log('用法：--build | --query "..." [--limit 5] | --stats')
  }
}
