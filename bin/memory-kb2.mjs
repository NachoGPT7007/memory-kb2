#!/usr/bin/env node
/**
 * memory-kb2 命令行入口 —— 给人用，不是给客户端用。
 *
 * MCP 服务负责「让 AI 检索记忆」，这个 CLI 负责「让你自己看库、建索引、排障」：
 * 建完索引想确认它真的生效了、查一条看看命中哪张卡、库有多大、链路自不自洽。
 *
 * 用法：
 *   memory-kb2 index                      建索引（沿用 MEM_VAULT）
 *   memory-kb2 search "候选池为什么是 80"   命令行检索，看命中与分数
 *   memory-kb2 stats                      库规模与索引状态
 *   memory-kb2 selfcheck [--serve]        本体体检
 *   memory-kb2 serve                      MCP stdio 服务（等同 src/server.mjs）
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const argv = process.argv.slice(2)
const cmd = argv[0] ?? 'help'

async function main() {
  switch (cmd) {
    case 'index': {
      const { build } = await import(join(ROOT, 'src/index.mjs'))
      const r = await build()
      console.log(`索引已建：${r.nCards} 卡 / ${r.nAtoms} 原子 / ${r.nPost} 倒排项，avgdl=${r.avg.toFixed(1)}`)
      console.log(`位置：${process.env.MEM_VAULT ?? '~/.memory-vault'}/.index/memory.sqlite（可随时删除重建）`)
      return
    }

    case 'search': {
      const q = argv.slice(1).join(' ').trim()
      if (q === '') {
        console.error('用法：memory-kb2 search "查询内容"')
        process.exit(2)
      }
      const { hybridQuery } = await import(join(ROOT, 'src/index.mjs'))
      // 与 MCP 服务同一条链路：两路召回 + RRF + 去重；没有查询向量时自动退回 BM25
      const limit = Number(process.env.MEM_CLI_LIMIT ?? 5)
      const { mode, ranked } = hybridQuery(q, { limit })
      if (!ranked.length) {
        console.log(`「${q}」无命中`)
        return
      }
      console.log(`模式 ${mode} · ${ranked.length} 条\n`)
      ranked.forEach((r, i) => {
        const title = String(r.title ?? '').slice(0, 50)
        const body = String(r.text ?? '').slice(0, 90).replace(/\s+/g, ' ')
        console.log(`${String(i + 1).padStart(2)}. ${title}   [${(r.score ?? 0).toFixed(4)}]`)
        if (body) console.log(`    ${body}`)
      })
      return
    }

    case 'stats': {
      const { openIndex } = await import(join(ROOT, 'src/index.mjs'))
      const { db, N, avgdl } = openIndex()
      const cards = db.prepare('SELECT COUNT(*) c FROM cards').get()?.c ?? 0
      const archived = db.prepare("SELECT COUNT(*) c FROM cards WHERE status = 'deleted'").get()?.c ?? 0
      const postings = db.prepare('SELECT COUNT(*) c FROM postings').get()?.c ?? 0
      db.close()
      console.log(`卡片     : ${cards}（其中归档 ${archived}）`)
      console.log(`原子     : ${N}`)
      console.log(`倒排项   : ${postings}`)
      console.log(`avgdl    : ${avgdl.toFixed(1)}`)
      console.log(`库路径   : ${process.env.MEM_VAULT ?? '~/.memory-vault'}`)
      return
    }

    case 'selfcheck': {
      const r = spawnSync(process.execPath, [join(ROOT, 'scripts/selfcheck.mjs'), ...argv.slice(1)], { stdio: 'inherit' })
      process.exit(r.status ?? 1)
    }

    case 'serve': {
      await import(join(ROOT, 'src/server.mjs'))
      return
    }

    default:
      console.log(`memory-kb2 —— 本地知识库检索

用法：
  memory-kb2 index                      建索引（读 $MEM_VAULT，默认 ~/.memory-vault）
  memory-kb2 search "查询内容"            命令行检索
  memory-kb2 stats                      库规模与索引状态
  memory-kb2 selfcheck [--serve]        本体体检（--serve 含 MCP 往返，只对副本用）
  memory-kb2 serve                      MCP stdio 服务

环境变量：
  MEM_VAULT        知识库根目录
  MEM_CLI_LIMIT    search 返回条数（默认 5）`)
      if (cmd !== 'help' && cmd !== '--help' && cmd !== '-h') process.exit(2)
  }
}

main().catch((error) => {
  console.error(`错误：${error?.message ?? error}`)
  process.exit(1)
})
