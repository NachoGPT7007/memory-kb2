#!/usr/bin/env node
/**
 * memory-server.mjs — 记忆库混合检索的 MCP 服务
 *
 * 链路：BM25（SQLite 倒排）+ 语义向量（通义千问 API）→ RRF 融合 →（默认）qwen3.7-text-rerank 批量精排
 *
 * 2026-11-04 起的改动：向量化与重排默认走阿里云百炼 API（见 embed-api.mjs），本地 ONNX 下线。
 *   - 启动不再加载 613MB embedding + 1.16GB reranker，内存归零
 *   - API 失败时才懒加载本地模型兜底；本地也失败则退回 BM25-only
 *   - 每次检索的成本（实测）：query 24 token + 重排 621 token ≈ ¥0.0003
 *
 * 质量基线（50 条评测集，本地 Qwen3-Emb 0.6B，2026-11-02）：RRF + 向量 @1 44% / @5 68% / @8 80%；
 * 开启重排 62% / 78% / 84%。换 API 后的对照见 docs/memory-系统维护.md 的评测记录。
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { DatabaseSync } from 'node:sqlite'
import { promises as fsp, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import * as api from './embed-api.mjs'

// ---- 抽取式改写（别名扩展，确定性，零生成）--------------------------------
// 只作用于词法路：hybridQuery 的 bm25Query 参数把改写限制在 BM25，向量路仍用原 query
// （改写引入的词不该污染 embedding）。别名表是独立数据文件，可人工维护。
// 默认关：2026-11-20 实测 PrecisionMemBench 76 条断言只多通过 1 条（13.2%→14.5%），
// 落在 ±2 条噪声带内；工程库 59 条不变。收益过小，因此保留 MEM_ALIAS=1 开关而不默认启用。
const ALIAS_ON = process.env.MEM_ALIAS === '1'
const ALIAS_FILE = process.env.MEM_ALIAS_FILE || new URL('./alias-table.json', import.meta.url).pathname
let aliasTable = null
function loadAliasTable() {
  if (aliasTable !== null) return aliasTable
  try {
    const raw = JSON.parse(readFileSync(ALIAS_FILE, 'utf8'))
    aliasTable = (raw.entries || [])
      .flatMap((e) => (e.aliases || []).map((a) => ({ alias: String(a).trim(), canonical: String(e.canonical || '').trim() })))
      .filter((x) => x.alias && x.canonical)
  } catch { aliasTable = [] }
  return aliasTable
}
const aliasHit = (q, w) => {
  if (/^[A-Za-z0-9 ._-]+$/.test(w)) {
    const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(^|[^A-Za-z0-9])${esc}([^A-Za-z0-9]|$)`, 'i').test(q)
  }
  return q.includes(w)
}
function expandAliases(q) {
  if (!ALIAS_ON) return q
  const add = []
  for (const { alias, canonical } of loadAliasTable()) if (aliasHit(q, alias)) add.push(canonical)
  return add.length ? `${q} ${[...new Set(add)].join(' ')}` : q
}

// vault 解析顺序：显式 MEM_VAULT → DSH_HOME/memory-vault（DSH 生态默认）→ ~/.memory-vault。
// 2026-11-20 补中间一档：旧实现直接把个人路径硬编码进源码（/home/nachogpt/.dsh-web-lab/memory-vault），
// 换成仓库版后默认值变成 ~/.memory-vault（不存在）→ memory_stats 报 "unable to open database file"。
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const VAULT = process.env.MEM_VAULT
  || (existsSync(path.join(DSH_HOME, 'memory-vault')) ? path.join(DSH_HOME, 'memory-vault') : path.join(os.homedir(), '.memory-vault'))
const DB = path.join(VAULT, '.index', 'memory.sqlite')
const CACHE = process.env.HF_CACHE || path.join(os.homedir(), '.cache', 'memory-kb2')
// 2026-11-05 评测：重排候选 10/20/50 的 @1 是 80/82/84、@8 是 86/90/94，单调正向且延迟几乎不涨。
// 默认取 20（@8 90%），deep 档取 50（@8 94%，成本约 2.5 倍）。
// 候选池大小是 profile 级参数（实测，2026-11-13）：
//   聊天域 pool 20→80 + rerank 开启：evidence 命中 52.5%→65%，覆盖 0.404→0.588
//   工程域 pool 20 已足够（top1 92%），不需要扩大
//
// 第 19 轮：候选池改为「按库规模自适应」，不再写死 20。
//   依据 1（矩阵实测，M02 40 题，top14）：pool 20 命中 55%，pool 54/80 命中 62.5%——候选池过浅时，
//     截断发生在去重/时间窗过滤之前，名额被吃掉。
//   依据 2（不变量实测，工程库 64 条查询）：融合深度由 hybridQuery 内部固定 200，`limit` 只截断
//     已排序的融合表，pool 5/20/80 的前 5 条 **64/64 完全一致**——加深候选池不改变排序，只减少
//     「过滤后名额不足」这一类损失，所以对工程域零风险。
//   曲线：pool = clamp(round(1.09·√卡数), 20, 80)。571 卡→26（工程，仍在低档），5413 卡→80（聊天，
//     命中该域实测最优）；万卡级库封顶 80，避免 rerank 成本随库规模线性上涨。
const POOL_FIXED = Number(process.env.MEM_POOL) || Number(process.env.RERANK_CANDIDATES) || 0
const POOL_MIN = Number(process.env.MEM_POOL_MIN) || 20
const POOL_MAX = Number(process.env.MEM_POOL_MAX) || 80
const DEEP = Number(process.env.RERANK_DEEP_CANDIDATES) || 50

/**
 * 查询向量缓存（2026-11-20 新增）。
 *
 * 一次检索的 166ms 里有九成是 embedding 往返，而同一个 query 的向量永远相同。
 * 个人使用时调试会反复问同一件事，缓存命中率不低。
 *
 * 两条安全边界：
 *   1. 含时间词的 query 不缓存——「今天」「刚才」的结果会随时间变化
 *   2. TTL 5 分钟——即使漏了时间词，也不会拿到太旧的结果
 * 环境变量：MEM_QVEC_CACHE=0 关闭；MEM_QVEC_TTL 改 TTL；MEM_QVEC_MAX 改容量
 */
const QVEC_CACHE_ON = process.env.MEM_QVEC_CACHE !== '0'
const QVEC_TTL_MS = Number(process.env.MEM_QVEC_TTL) || 5 * 60 * 1000
const QVEC_CACHE_MAX = Number(process.env.MEM_QVEC_MAX) || 1000
const qvecCache = new Map()
let qvecHits = 0
let qvecMisses = 0

// 检索结果缓存（2026-11-20）：查询向量缓存之后，整条检索链路剩下的本地开销还有约 50ms
// （BM25 2.8 + 全表读 8 + 向量 topK 10 + RRF 33）。命中时直接返回上次组装好的文本。
// 失效靠索引版本（meta.built_at）：重建索引 → built_at 变 → 旧条目再也命不中；
// TTL 只是兜底，不承担正确性。默认开，MEM_RESULT_CACHE=0 关。
const RCACHE_ON = process.env.MEM_RESULT_CACHE !== '0'
const RCACHE_TTL_MS = Number(process.env.MEM_RESULT_CACHE_TTL) || 5 * 60 * 1000
const RCACHE_MAX = Number(process.env.MEM_RESULT_CACHE_MAX) || 500
const resultCache = new Map()
let resultHits = 0
let resultMisses = 0

/** 含时间词的 query 不走缓存。 */
const TIME_WORD = /今天|今晚|昨天|现在|当前|刚才|刚刚|本周|这周|本月|这个月|最近\s*\d|today|now|yesterday|current/i

async function embedQueryCached(q) {
  if (!QVEC_CACHE_ON || TIME_WORD.test(q)) return api.embedOne(q)
  const now = Date.now()
  const hit = qvecCache.get(q)
  if (hit !== undefined && now - hit.at < QVEC_TTL_MS) {
    qvecHits += 1
    qvecCache.delete(q)
    qvecCache.set(q, hit) // 移到末尾，维持 LRU 顺序
    return hit.vec
  }
  const vec = await api.embedOne(q)
  qvecMisses += 1
  qvecCache.set(q, { vec, at: now })
  if (qvecCache.size > QVEC_CACHE_MAX) qvecCache.delete(qvecCache.keys().next().value)
  return vec
}

/** 按库规模算候选深度；MEM_POOL 显式给值时优先。 */
function adaptivePool() {
  if (POOL_FIXED) return POOL_FIXED
  let cards = 0
  try { cards = idx?.countCards?.() || 0 } catch { cards = 0 }
  if (!cards) return POOL_MIN
  return Math.max(POOL_MIN, Math.min(POOL_MAX, Math.round(1.09 * Math.sqrt(cards))))
}


// 本地兜底（已下线，仅在 API 失败时懒加载）
const LOCAL_EMBED = process.env.EMBED_MODEL || 'onnx-community/Qwen3-Embedding-0.6B-ONNX'
const LOCAL_RERANKER = process.env.RERANKER || 'Xenova/bge-reranker-base'
const LOCAL_RERANKER_KIND = /qwen/i.test(LOCAL_RERANKER) ? 'generative' : 'classifier'

let idx = null
let ready = 'loading'
let localEmbedFn = null
let localEmbedState = 'idle'   // idle | loading | ready | failed
let localRerank = null
let localRerankState = 'idle'
let lastNote = ''              // 最近一次降级的说明，供 stats 显示

async function init() {
  idx = await import('../scripts/memory-index.mjs')
  detectProfile()
  const st = api.apiStatus()
  ready = st.hasKey ? 'hybrid(api)' : 'bm25-only: 缺少 ALI_API_KEY'
  return ready
}

/** 本地 embedding 兜底：只在 API 失败时加载，成功一次后常驻 */
async function ensureLocalEmbed() {
  if (localEmbedState === 'ready') return localEmbedFn
  if (localEmbedState === 'loading' || localEmbedState === 'failed') return null
  localEmbedState = 'loading'
  try {
    const { pipeline, env } = await import('@huggingface/transformers')
    env.cacheDir = CACHE
    const extract = await pipeline('feature-extraction', LOCAL_EMBED, { dtype: 'q8' })
    const POOL = /qwen/i.test(LOCAL_EMBED) ? 'last_token' : 'mean'
    localEmbedFn = async (q) => (await extract([q], { pooling: POOL, normalize: true })).tolist()[0]
    localEmbedState = 'ready'
    return localEmbedFn
  } catch (e) {
    localEmbedState = 'failed'
    return null
  }
}

/** 本地 reranker 兜底：同样懒加载 */
async function ensureLocalReranker() {
  if (localRerankState === 'ready') return localRerank
  if (localRerankState === 'loading' || localRerankState === 'failed') return null
  localRerankState = 'loading'
  try {
    const T = await import('@huggingface/transformers')
    T.env.cacheDir = CACHE
    if (LOCAL_RERANKER_KIND === 'classifier') {
      // 关键：不能用 text-classification pipeline —— 它会 sigmoid，
      // 而 bge-reranker 的原始 logit 常在 20 以上，sigmoid 后全部 1.000000，
      // 排序完全失去区分度（实测四条相关度差异极大的文本分数一模一样）。必须取 raw logits。
      const tok = await T.AutoTokenizer.from_pretrained(LOCAL_RERANKER)
      const model = await T.AutoModelForSequenceClassification.from_pretrained(LOCAL_RERANKER, { dtype: 'q8' })
      localRerank = { kind: 'classifier', tok, model }
    } else {
      const tok = await T.AutoTokenizer.from_pretrained(LOCAL_RERANKER)
      const model = await T.AutoModelForCausalLM.from_pretrained(LOCAL_RERANKER, { dtype: 'q8' })
      const yesId = tok.encode('yes', { add_special_tokens: false })[0]
      const noId = tok.encode('no', { add_special_tokens: false })[0]
      localRerank = { kind: 'generative', tok, model, yesId, noId }
    }
    localRerankState = 'ready'
    return localRerank
  } catch (e) {
    localRerankState = 'failed'
    return null
  }
}

const INSTRUCT = 'Given a Chinese technical note query, retrieve the note that answers it'
const PROMPT_HEAD = `<|im_start|>system\nJudge whether the Document meets the requirements based on the Query and the Instruct provided. Note that the answer can only be "yes" or "no".<|im_end|>\n<|im_start|>user\n`
const buildPrompt = (q, d) => `${PROMPT_HEAD}<Instruct>: ${INSTRUCT}\n<Query>: ${q}\n<Document>: ${d}<|im_end|>\n<|im_start|>assistant\n`

/** 本地 reranker 逐候选打分（兜底路径） */
async function localRerankScore(q, doc) {
  const r = await ensureLocalReranker()
  if (!r) return null
  if (r.kind === 'classifier') {
    const inputs = await r.tok(q, { text_pair: doc, padding: true, truncation: true, max_length: 512 })
    const out = await r.model(inputs)
    const v = out.logits.data[0]
    return Number.isFinite(v) ? v : null
  }
  const inputs = await r.tok([buildPrompt(q, doc)], { padding: true, truncation: true, max_length: 1024 })
  const out = await r.model(inputs)
  const dims = out.logits.dims
  const last = (dims[1] - 1) * dims[2]
  const data = out.logits.data
  const y = data[last + r.yesId]
  const n = data[last + r.noId]
  return 1 / (1 + Math.exp(-(y - n)))
}

/** 一次批量重排；失败返回 null 让调用方降级 */
async function rerankAll(q, docs) {
  try {
    const res = await api.rerank(q, docs, { topN: docs.length })
    if (res.length !== docs.length) return null
    const m = new Map(res.map((r) => [r.index, r.score]))
    return docs.map((_, i) => m.get(i) ?? -Infinity)
  } catch (e) {
    lastNote = `重排 API 失败：${String(e?.message || e).slice(0, 60)}`
    const local = await ensureLocalReranker()
    if (!local) return null
    const out = []
    for (const d of docs) {
      const s = await localRerankScore(q, d)
      if (s === null) return null
      out.push(s)
    }
    lastNote += '，已切本地 reranker'
    return out
  }
}

/** 取卡片正文前 200 字给 reranker 看——判别信息比单条原子多一个数量级 */
async function summaryOf(relPath) {
  try {
    const t = await fsp.readFile(path.join(VAULT, relPath), 'utf8')
    const body = t.split(/^---$/m).slice(2).join('')
      .replace(/^#{1,6}.*$/gm, '').replace(/```[\s\S]*?```/g, '')
    return body.replace(/\s+/g, ' ').trim().slice(0, 200)
  } catch { return '' }
}

// ---- 索引新鲜度自检（解决两个静默：新卡没进索引 / timer 挂了） ----------
const STAMP = path.join(VAULT, '.index', '.last-sync')
const SYNC_SCRIPT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'vendor/embed/sync-index.mjs')
let lastCheck = 0
let syncing = false
let lastStale = { stale: false, lagMs: 0 }

async function newestMtime(dir, acc = { t: 0 }) {
  let entries
  try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { return acc }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (!['.git', '.index', 'node_modules'].includes(e.name)) await newestMtime(p, acc) }
    else if (e.name.endsWith('.md')) { try { const st = await fsp.stat(p); if (st.mtimeMs > acc.t) acc.t = st.mtimeMs } catch {} }
  }
  return acc
}

/** 最多每 60 秒真正检查一次；落后则后台拉起 sync（不阻塞当前查询） */
async function ensureFresh() {
  const now = Date.now()
  if (now - lastCheck < 60_000) return lastStale
  lastCheck = now
  let lastSync = 0
  try { lastSync = Number(await fsp.readFile(STAMP, 'utf8')) || 0 } catch {}
  const { t } = await newestMtime(VAULT)
  const stale = t > lastSync
  lastStale = { stale, lagMs: Math.max(0, t - lastSync) }
  if (stale && !syncing) {
    syncing = true
    try {
      const { spawn } = await import('node:child_process')
      spawn('node', [SYNC_SCRIPT], { detached: true, stdio: 'ignore' }).unref()
    } catch {}
    setTimeout(() => { syncing = false }, 120_000)
  }
  return lastStale
}

// 检索命中账本：每次 memory_search 落一行，供 scripts/memory-recall-stats.mjs 做区域加权统计。
// 只追加、不参与检索；写失败不影响返回。
const LEDGER = path.join(path.dirname(VAULT), 'memory-recall-ledger.jsonl')
async function logRecall(row) {
  try { await fsp.appendFile(LEDGER, JSON.stringify(row) + '\n') } catch {}
}

// 查询类型判定：概念名（"物债二分"）vs 描述性（"记忆库怎么回滚"）。
// 控制变量实测（2026-11-13）：概念名场景 title 权重 1.0→3.0 让 recall@1 从 93.0%→99.6%（工程库）、
// 80.1%→95.9%（wiki）；描述性场景则相反，3.0 会让它掉 3.4pp。所以按这一次查询的类型切权重。
function isConceptQuery(q) {
  const t = String(q || '').trim()
  if (!t) return false
  if (t.length > 14) return false
  if (/[吗呢吧啊哈呀嘛哦]|[？?]/.test(t)) return false
  if (/怎么|如何|为什么|为何|是不是|要不要|能不能|有没有|哪里|什么时|该不该|能不能/.test(t)) return false
  return true
}
// 控制变量实测（2026-11-13，工程库 15 条人工标注真实问题）：
//   统一 ×3.0 → top1 10/15；路由（概念×3/描述×1.0）→ 8/15；统一 ×1.0 → 8/15。
// leave-one-out 上「描述性要低权重」的结论不适用于真实问法，故路由默认关闭，统一用高 title 权重。
// MEM_QUERY_ROUTING=1 可重新打开路由做实验。
const QUERY_ROUTING = process.env.MEM_QUERY_ROUTING === '1'
const UNIFIED_TITLE_W = Number(process.env.MEM_TITLE_W) || 3.0
const CONCEPT_TITLE_W = Number(process.env.MEM_CONCEPT_TITLE_W) || 3.0
const DESCRIPTIVE_TITLE_W = Number(process.env.MEM_DESC_TITLE_W) || 1.0

// ---------------------------------------------------------------- 场景档位（v0.4.0）
// 场景级路由 ≠ 查询级路由。查询级（按问题类型切参数）已两次证伪，默认关；
// 场景级是「换一个库就换一套默认参数」，按库的语料特征判定，只算一次。
//
// 实测特征（2026-11-14，三个真实库）：
//   库       卡数    原子/卡  标题字数  正文字数
//   工程库   571     9.4      34.7      2935
//   法学wiki 941     —        6.8       4099
//   聊天库   5413    2.0      50.4      372
// 判定：标题短（<15 字）→ 概念卡库；原子/卡少且正文短 → 对话沉淀库；其余工程库。
// 显式环境变量永远优先（MEM_TITLE_W / MEM_DEFAULT_LIMIT / MEM_RERANK / MEM_VECTOR）。
const PROFILE = { name: 'unknown', limit: 5, rerank: false, titleW: 3.0, vector: true, why: '未检测' }

function detectProfile() {
  try {
    const db = new DatabaseSync(DB, { readOnly: true })
    const cards = db.prepare('SELECT COUNT(*) c FROM cards').get()?.c || 0
    const avgTitle = db.prepare('SELECT AVG(LENGTH(title)) a FROM cards').get()?.a || 0
    const atoms = db.prepare("SELECT COUNT(*) c FROM atoms WHERE nature != 'title'").get()?.c || 0
    const avgBody = db.prepare("SELECT AVG(LENGTH(text)) a FROM atoms WHERE nature='body'").get()?.a || 0
    db.close()
    if (!cards) return PROFILE
    const apc = atoms / cards
    if (avgTitle < 15) {
      Object.assign(PROFILE, { name: 'wiki', limit: 8, rerank: false, titleW: 3.0, vector: false,
        why: `标题均长 ${avgTitle.toFixed(1)} 字 → 概念卡库（法学 wiki：dense 0.434 < BM25 0.529，故关向量）` })
    } else if (apc <= 3 && avgBody < 800) {
      Object.assign(PROFILE, { name: 'chat', limit: 14, rerank: true, titleW: 3.0, vector: true,
        why: `原子/卡 ${apc.toFixed(1)}、正文均长 ${avgBody.toFixed(0)} 字 → 对话沉淀库（limit 8→14 命中 +3.3pp）` })
    } else {
      Object.assign(PROFILE, { name: 'engineering', limit: 5, rerank: false, titleW: 3.0, vector: true,
        why: `原子/卡 ${apc.toFixed(1)}、标题均长 ${avgTitle.toFixed(1)} 字 → 工程知识库（精确查找，rerank 无收益）` })
    }
  } catch (e) {
    PROFILE.why = `检测失败：${String(e?.message || e).slice(0, 60)}`
  }
  return PROFILE
}

const server = new Server({ name: 'memory-kb2', version: '0.4.0' }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'memory_search',
      description:
        '从本地记忆库检索知识卡（BM25 + 通义千问向量 RRF 融合 + qwen3.7 重排）。用于找项目背景、历史决策、排障记录。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '自然语言描述要查的事' },
          limit: { type: 'number', description: '返回条数，默认 5，最大 20' },
          rerank: { type: 'boolean', description: '是否精排（默认 false：工程库实测 90% vs 92% 打平，但每次多 120–200ms；只在需要语义泛化时显式置 true）' },
          deep: { type: 'boolean', description: '深挖档：候选与重排扩到更深（默认按库规模自适应，571 卡→26 / 5413 卡→80，封顶 80），单次成本更高' },
          include_deleted: { type: 'boolean', description: '是否包含已归档（status: deleted）的卡：默认 false（它们代表结论已不再成立）；查历史决策时置 true' },
          scope: {
            type: 'array', items: { type: 'string' },
            description: '按 scope 收窄，如 ["domain:code"]。卡片 frontmatter 的 scope 字段命中任一即保留；不传则完全不过滤（默认行为不变）',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'memory_update',
      description:
        '更新一张过时的记忆卡。检索到卡片的描述与现状不符（版本/路径/端口/结论变了）时用：传 text 追加修正记录（保留历史），或传 close_atom 把某条原子标记为不再成立。',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '卡片相对路径，如 08-Mistakes/xxx.md（memory_search 返回的那个）' },
          text: { type: 'string', description: '追加的修正内容，一段话，会写进「更新记录」小节' },
          close_atom: { type: 'string', description: '要标记失效的原子 id（可选）' },
        },
        required: ['path'],
      },
    },
    {
      name: 'memory_map',
      description:
        '记忆库地图：按目录列出卡片标题与路径，让你在检索前知道「库里到底有什么」。'
        + '没有明确关键词、或任务面较宽时先看地图，再决定用 memory_search 查什么。'
        + '超出字符预算的部分会截断并提示，可用 dir 收窄（模仿 aider 的 repo map：先给全库符号，再按需读取）。',
      inputSchema: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: '只看某个顶层目录，如 02-Projects（可选）' },
          budget: { type: 'number', description: '返回文本的字符预算，默认 8000（约 5k token），上限 40000' },
          include_deleted: { type: 'boolean', description: '是否包含已归档卡，默认否' },
        },
      },
    },
    {
      name: 'memory_get',
      description:
        '按路径读取整张卡（frontmatter + 全部正文）。memory_search 只返回命中片段；'
        + '当你要看完整内容、或需基于这张卡和别的卡做综合判断时用它（对应 aider 的「按需请求具体文件」）。',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '卡片相对路径，memory_search / memory_map 返回的那个' },
        },
        required: ['path'],
      },
    },
    {
      name: 'memory_stats',
      description: '查看记忆索引状态（卡片数、原子数、向量化与重排模型、API 状态与最近失败原因）。',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params

  if (name === 'memory_map') {
    const dir = String(args.dir || '').trim().replace(/^\/+|\/+$/g, '')
    const budget = Math.min(Math.max(Number(args.budget) || 8000, 1000), 40000)
    const includeDeleted = args.include_deleted === true
    const db = new DatabaseSync(DB, { readOnly: true })
    const rows = db.prepare(
      `SELECT path, title, COALESCE(status,'') AS status, mtime FROM cards
       ${dir ? 'WHERE path LIKE ?' : ''} ORDER BY path`,
    ).all(...(dir ? [dir + '/%'] : []))
    db.close()
    const kept = rows.filter((r) => includeDeleted || String(r.status) !== 'deleted')
    const byDir = new Map()
    for (const r of kept) {
      const top = String(r.path || '').split('/')[0] || '(root)'
      if (!byDir.has(top)) byDir.set(top, [])
      byDir.get(top).push(r)
    }
    let out = `# 记忆库地图（${kept.length} 张卡${dir ? `，仅 ${dir}` : ''}）\n`
    let used = out.length, shown = 0, dropped = 0
    for (const [top, list] of [...byDir.entries()].sort((a, b) => b[1].length - a[1].length)) {
      const head = `\n## ${top}（${list.length}）\n`
      if (used + head.length > budget) { dropped += list.length; continue }
      out += head; used += head.length
      for (const r of list.sort((a, b) => (b.mtime || 0) - (a.mtime || 0))) {
        const day = r.mtime ? new Date(r.mtime).toISOString().slice(0, 10) : ''
        const line = `- ${r.title} ｜ ${r.path}${day ? ` ｜ ${day}` : ''}\n`
        if (used + line.length > budget) { dropped++; continue }
        out += line; used += line.length; shown++
      }
    }
    if (dropped) out += `\n…预算已用尽，还有 ${dropped} 张未列出。用 dir 收窄，或调大 budget。\n`
    return { content: [{ type: 'text', text: out }] }
  }

  if (name === 'memory_get') {
    const rel = String(args.path || '').trim().replace(/^\/+/, '')
    if (!rel) return { content: [{ type: 'text', text: '缺 path 参数' }], isError: true }
    const root = path.resolve(VAULT)
    const abs = path.resolve(root, rel)
    // 防路径穿越：只允许读 vault 内的文件
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      return { content: [{ type: 'text', text: '拒绝：path 必须位于 vault 内' }], isError: true }
    }
    try {
      const text = await fsp.readFile(abs, 'utf8')
      // 反馈闭环最小版本：复用既有召回账本，get 也落一行（action 区分），
      // 后续可用 scripts/memory-recall-stats.mjs 统计「哪些卡被真正读过」。
      await logRecall({ ts: new Date().toISOString(), action: 'get', path: rel })
      return { content: [{ type: 'text', text }] }
    } catch {
      return { content: [{ type: 'text', text: `读取失败：${rel} 不存在或不可读` }], isError: true }
    }
  }

  if (name === 'memory_stats') {
    const db = new DatabaseSync(DB, { readOnly: true })
    const cards = db.prepare('SELECT COUNT(*) c FROM cards').get().c
    const atoms = db.prepare('SELECT COUNT(*) c FROM atoms').get().c
    db.close()
    const st = api.apiStatus()
    const apiLine = st.hasKey
      ? `向量化：${st.embedModel}（API）｜重排：${st.rerankModel}（API）`
      : `向量化与重排：未配置（缺少 ALI_API_KEY）`
    const callLine = st.calls
      ? `API 调用 ${st.calls} 次，失败 ${st.fail} 次；最近 ${st.lastStatus ?? '-'}，${st.lastMs ?? '-'}ms${st.lastError ? `，错误：${st.lastError}` : ''}`
      : 'API 尚未调用（首次检索时验证）'
    const localLine = `本地兜底：embedding ${localEmbedState} / reranker ${localRerankState}（未加载不占内存）`
    const cacheTotal = qvecHits + qvecMisses
    const cacheLine = QVEC_CACHE_ON
      ? `查询向量缓存：命中 ${qvecHits} / 总计 ${cacheTotal}${cacheTotal ? `（${Math.round((qvecHits / cacheTotal) * 100)}%）` : ''}${qvecCache.size ? `，驻留 ${qvecCache.size} 条` : ''}`
      : '查询向量缓存：已关闭（MEM_QVEC_CACHE=0）'
    const rcacheTotal = resultHits + resultMisses
    const rcacheLine = RCACHE_ON
      ? `结果缓存：命中 ${resultHits} / 总计 ${rcacheTotal}${rcacheTotal ? `（${Math.round((resultHits / rcacheTotal) * 100)}%）` : ''}${resultCache.size ? `，驻留 ${resultCache.size} 条` : ''}`
      : '结果缓存：已关闭（MEM_RESULT_CACHE=0）'
    return {
      content: [{
        type: 'text',
        text: [
          `检索模式：${ready}`,
          `卡片 ${cards} / 原子 ${atoms}`,
          apiLine,
          callLine,
          localLine,
          cacheLine,
          rcacheLine,
          lastNote ? `最近降级：${lastNote}` : null,
          `索引新鲜度：${lastStale.stale ? `落后 ${Math.round(lastStale.lagMs / 60000)} 分钟（已触发同步）` : '最新'}`,
        ].filter(Boolean).join('\n'),
      }],
    }
  }

  if (name === 'memory_update') {
    const rel = String(args.path || '').trim()
    if (!rel) return { content: [{ type: 'text', text: '（缺少 path）' }], isError: true }
    const abs = path.resolve(VAULT, rel)
    if (!abs.startsWith(path.resolve(VAULT))) {
      return { content: [{ type: 'text', text: '（路径越界，拒绝）' }], isError: true }
    }
    let text
    try { text = await fsp.readFile(abs, 'utf8') } catch {
      return { content: [{ type: 'text', text: `（卡片不存在：${rel}）` }], isError: true }
    }
    const changes = []

    if (args.close_atom) {
      const id = String(args.close_atom).trim()
      const lines = text.split('\n')
      let inBlock = false
      let touched = false
      for (let i = 0; i < lines.length; i++) {
        if (/^\s+- id:\s*/.test(lines[i])) inBlock = lines[i].includes(id)
        if (inBlock && /^\s+active:\s*true\s*$/.test(lines[i])) { lines[i] = lines[i].replace('true', 'false'); touched = true; break }
      }
      if (!touched) return { content: [{ type: 'text', text: `（没找到可关闭的原子：${id}）` }], isError: true }
      text = lines.join('\n')
      changes.push(`原子 ${id} 标记为不再成立`)
    }

    if (args.text) {
      const stamp = new Date().toISOString().slice(0, 10)
      text = text.replace(/\s*$/, '') + `\n\n## 更新记录 ${stamp}\n\n${String(args.text).trim()}\n`
      changes.push('已追加更新记录')
    }

    if (!changes.length) return { content: [{ type: 'text', text: '（text 与 close_atom 至少给一个）' }], isError: true }

    await fsp.writeFile(abs, text, 'utf8')
    // 让下一次检索能感知到索引落后（ensureFresh 依赖 .last-sync 与 mtime 的比较）
    return {
      content: [{
        type: 'text',
        text: `已更新 ${rel}：${changes.join('；')}。索引会在下次检索时自动同步。`,
      }],
    }
  }

  if (name === 'memory_search') {
    const q = String(args.query || '').trim()
    if (!q) return { content: [{ type: 'text', text: '（未提供查询词）' }], isError: true }
    // profile 层的默认返回条数：工程 5（精确查找，够用且省 token）；
    // 聊天档实测 limit 8→14 命中率 +3.3pp（2026-11-13），用 MEM_DEFAULT_LIMIT=14 切换。
    const DEFAULT_LIMIT = Math.min(Math.max(Number(process.env.MEM_DEFAULT_LIMIT) || PROFILE.limit, 1), 20)
    const limit = Math.min(Math.max(Number(args.limit) || DEFAULT_LIMIT, 1), 20)
    const includeDeleted = args.include_deleted === true
    // scope：显式传入才过滤；不传保持旧行为。取值来自卡片 frontmatter 的 scope 字段。
    const scope = Array.isArray(args.scope) ? args.scope.map((x) => String(x).trim()).filter(Boolean) : null
    // 实测（2026-11-13，工程库 59 条人工标注，标注已放宽为多可接受卡）：
    //   无 rerank top1 92% / top3 100%；加 rerank 后 top1 73% / top3 97%。
    // 工程记忆是「精确找那张卡」，重排的语义泛化会换成相关但非目标卡，故默认关闭。
    // 需要时显式传 rerank: true。
    // 显式参数优先；其次 profile 环境变量 MEM_RERANK=1；默认关（工程域无收益且有延迟）
    const rerankEnv = process.env.MEM_RERANK
    const rerankDefault = rerankEnv === '1' ? true : rerankEnv === '0' ? false : PROFILE.rerank
    const useRerank = args.rerank === true || (args.rerank === undefined && rerankDefault)
    // 候选深度：自适应 / MEM_POOL 显式值，deep 档取更深；无论 rerank 开关都按此深度取候选，
    // 截断到 limit 放到去重之后（否则去重/时间窗过滤吃掉的槽位补不回来）。
    const basePool = adaptivePool()
    const poolSize = args.deep ? Math.max(DEEP, basePool) : basePool
    const fetchN = Math.max(poolSize, limit)

    const t0 = Date.now()
    const fresh = await ensureFresh()
    // 索引版本：重建索引会让 built_at 变，旧缓存条目自然失效
    let idxVersion = ''
    try {
      const d = new DatabaseSync(DB, { readOnly: true })
      idxVersion = d.prepare("SELECT v FROM meta WHERE k='built_at'").get()?.v || ''
      d.close()
    } catch { /* 旧索引没有 meta 表时退化为「不缓存版本」 */ }
    const rcacheKey = [q, (scope || []).join(','), limit, useRerank ? 1 : 0, includeDeleted ? 1 : 0, idxVersion].join('\u0001')
    if (RCACHE_ON) {
      const hit = resultCache.get(rcacheKey)
      if (hit && Date.now() - hit.at < RCACHE_TTL_MS) {
        resultHits += 1
        resultCache.delete(rcacheKey); resultCache.set(rcacheKey, hit)   // LRU 提到末尾
        const msCached = Date.now() - t0
        return { content: [{ type: 'text', text: hit.text.replace(/，\d+ms/, `，${msCached}ms（结果缓存命中）`) }] }
      }
      resultMisses += 1
    }
    let ranked = []
    let mode = ready
    lastNote = ''

    // 1) query 向量：API 优先，失败才懒加载本地
    const concept = isConceptQuery(q)
    const titleW = QUERY_ROUTING ? (concept ? CONCEPT_TITLE_W : DESCRIPTIVE_TITLE_W) : (Number(process.env.MEM_TITLE_W) || PROFILE.titleW)

    // 向量开关必须在 embedding 之前定：旧实现先无条件调 embedQueryCached 再判断 vectorOn，
    // 导致 MEM_VECTOR=0 时仍然付一次 embedding 的往返（约 200ms）与调用费，
    // 「关向量换延迟」这条路是断的（2026-11-20 实测：novector p50 249ms vs baseline 278ms）。
    const vectorOn = process.env.MEM_VECTOR === '0' ? false : process.env.MEM_VECTOR === '1' ? true : PROFILE.vector
    let qvec = null
    if (vectorOn) {
      try {
        qvec = await embedQueryCached(q)
      } catch (e) {
        lastNote = `向量化 API 失败：${String(e?.message || e).slice(0, 60)}`
        const local = await ensureLocalEmbed()
        if (local) { qvec = await local(q); lastNote += '，已切本地模型' }
      }
    }
    const bmQ = expandAliases(q)
    if (qvec && vectorOn) {
      // 融合顺序与 limit 无关（内部两路各取 200 再 RRF），取满 fetchN 让后续去重有牌可打
      const r = idx.hybridQuery(q, { limit: fetchN, qvec, titleW, includeDeleted, bm25Query: bmQ, scope })
      ranked = r.ranked
      mode = r.mode
    } else {
      ranked = idx.query(bmQ, { limit: fetchN, includeDeleted, titleW, scope }).ranked
      mode = 'bm25'
    }
    if (bmQ !== q) mode += '+alias'

    // 2) 重排：一次批量请求
    if (useRerank && ranked.length > 1) {
      const docs = []
      for (const c of ranked) docs.push(`${c.title}\n${await summaryOf(c.path)}`)
      const scores = await rerankAll(q, docs)
      if (scores) {
        ranked = ranked
          .map((c, i) => ({ ...c, score: scores[i] }))
          .sort((a, b) => b.score - a.score)
        mode += '+rerank'
      }
    }

    // 内容级去重：同一内容的多份副本（真库 ↔ Obsidian 镜像/备份）不再各占一个名额。
    // 依据：真实工程库实测，top5 唯一内容 3.60 → 5.00（2026-11-13）。
    const seenFp = new Set()
    const uniqRanked = []
    for (const c of ranked) {
      let fp = ''
      try { fp = (await summaryOf(c.path)).replace(/\s+/g, '').slice(0, 160) } catch {}
      if (!fp) fp = 'path:' + c.path
      if (seenFp.has(fp)) continue
      seenFp.add(fp)
      uniqRanked.push(c)
      if (uniqRanked.length >= limit) break
    }

    const out = uniqRanked
    const ms = Date.now() - t0
    await logRecall({
      ts: new Date().toISOString(),
      query: q,
      mode,
      ms,
      hits: out.map((h) => ({
        path: h.path, title: h.title, score: Number(h.score ?? 0),
        kind: (h.path || '').split('/')[0] || '',
      })),
    })
    if (!out.length) return { content: [{ type: 'text', text: `记忆库中没有与「${q}」相关的内容。` }] }
    // 卡片元数据（mtime / status）：Agent 要判断「这张是不是我要的那张、还作不作数」，
    // 只给标题和一行片段不够。一次 SQL 批量取，不增加往返、不改排序。
    const cardMeta = new Map()
    try {
      const dbm = new DatabaseSync(DB, { readOnly: true })
      const phm = out.map(() => '?').join(',')
      for (const r of dbm.prepare(`SELECT path, mtime, COALESCE(status,'') AS status FROM cards WHERE path IN (${phm})`).all(...out.map((h) => h.path))) cardMeta.set(r.path, r)
      dbm.close()
    } catch { /* 元数据取不到不影响检索结果 */ }
    const lines = out.map((h, i) => {
      const score = h.score != null ? ` [${Number(h.score).toFixed(3)}]` : ''
      // 命中段落优先展示正文答案段（nature=body），没有才退回 frontmatter 原子。
      // 这样返回的是「为什么匹配」，而不是固定的卡片开头 160 字。
      const hits = h.hitAtoms || []
      const bodyHits = hits.filter((a) => a.nature === 'body').map((a) => a.text)
      const factHits = hits.filter((a) => a.nature !== 'body').map((a) => a.text)
      const show = (bodyHits.length ? bodyHits : factHits).slice(0, 2)
      const hitLine = show.length
        ? `\n结论：${show.map((t) => t.slice(0, 180)).join(' ／ ')}`
        : `\n结论：${(h.text || '').slice(0, 180)}`
      const m = cardMeta.get(h.path)
      const day = m?.mtime ? new Date(m.mtime).toISOString().slice(0, 10) : ''
      // 只在「非正常」状态时才标出来（deleted/rejected/pending），active/approved 是常态、不占位置
      const st = m?.status && !['active', 'approved'].includes(m.status) ? ` ｜ 状态：${m.status}` : ''
      return `### ${i + 1}. ${h.title}${score}\n路径：${h.path}${day ? ` ｜ 更新：${day}` : ''}${st}${hitLine}`
    })
    // 归档卡提示（2026-11-14）：库里有 14.9% 的卡 status: deleted（结论已不再成立），默认不返回。
    // 用户查历史时「什么都搜不到」会以为记忆丢了，而卡其实在库里。只在名额没满时提一句，
    // 不动排序、不改默认返回，提示里的开关就是 include_deleted。
    let archivedHint = ''
    if (!includeDeleted) {
      try {
        // 用同一条查询再取一次「含归档」的融合结果：不看名额满不满，看归档卡是否本该进前 limit。
        // 分数同尺度（同一个 RRF），所以「本该上榜却被隐藏」这件事可以判定，不会对无关查询乱报。
        const probe = qvec
          ? idx.hybridQuery(q, { limit: poolSize, qvec, titleW, includeDeleted: true }).ranked
          : idx.query(q, { limit: poolSize, includeDeleted: true, titleW }).ranked
        const topPaths = probe.slice(0, limit).map((h) => h.path).filter(Boolean)
        if (topPaths.length) {
          const db2 = new DatabaseSync(DB, { readOnly: true })
          const ph2 = topPaths.map(() => '?').join(',')
          const del = db2.prepare(`SELECT COUNT(*) c FROM cards WHERE COALESCE(status,'')='deleted' AND path IN (${ph2})`).get(...topPaths).c
          db2.close()
          if (del > 0) archivedHint = `另有 ${del} 张已归档卡本该进前 ${limit}（结论已不再成立），查历史加 include_deleted: true`
        }
      } catch { /* 提示失败不影响结果 */ }
    }
    // 分步检索的下一跳提示（复用 cards 表，不新建索引）：
    // 返回结果最主要的那个目录下、没进结果的最近几张卡，告诉 Agent「这里还有东西可看」。
    // 只给标题不给内容，避免撑上下文；要读用 memory_get。
    const notes = [
      fresh.stale ? `索引落后 ${Math.round(fresh.lagMs / 60000)} 分钟、已触发后台同步，新内容可能还查不到` : '',
      lastNote,
      archivedHint,
    ].filter(Boolean)
    // 分步检索的下一跳提示（复用 cards 表，不新建索引）：
    // 返回结果最主要的那个目录下、没进结果的最近几张卡，告诉 Agent「这里还有东西可看」。
    // 只给标题不给内容，避免撑上下文；要读用 memory_get。
    try {
      const topDir = (out[0]?.path || '').split('/')[0]
      if (topDir) {
        const got = new Set(out.map((h) => h.path))
        const dbn = new DatabaseSync(DB, { readOnly: true })
        const rows = dbn.prepare(
          "SELECT title, path FROM cards WHERE path LIKE ? AND COALESCE(status,'') != 'deleted' ORDER BY mtime DESC LIMIT 12",
        ).all(topDir + '/%')
        dbn.close()
        const extra = rows.filter((r) => !got.has(r.path)).slice(0, 3)
        if (extra.length) notes.push(`同目录（${topDir}）还有未返回的卡，例如：${extra.map((r) => r.title).join('、')}——要读全文用 memory_get`)
      }
    } catch { /* 提示失败不影响检索结果 */ }
    const payload = {
      content: [{
        type: 'text',
        text: `检索到 ${out.length} 条（模式：${mode}｜${PROFILE.name}档·${QUERY_ROUTING ? (concept ? '概念名' : '描述性') : '统一'}·标题权×${titleW}，${ms}ms${notes.length ? '；' + notes.join('；') : ''}）：\n\n${lines.join('\n\n')}`,
      }],
    }
    if (RCACHE_ON) {
      resultCache.set(rcacheKey, { at: Date.now(), text: payload.content[0].text })
      if (resultCache.size > RCACHE_MAX) resultCache.delete(resultCache.keys().next().value)
    }
    return payload
  }

  return { content: [{ type: 'text', text: `未知工具：${name}` }], isError: true }
})

await init()
await server.connect(new StdioServerTransport())
