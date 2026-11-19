#!/usr/bin/env node
/**
 * eval-coderag.mjs —— CodeRAG-Bench（RepoEval function-level）检索评测
 *
 * 数据：code-rag-bench/retrieval/datasets/repoeval__<repo>/{corpus,queries}.jsonl + qrels/test.tsv
 * 口径：每个仓库独立语料（官方就是 per-instance 检索），query → top-k 窗口 → 与 qrels 对照
 * 指标：Recall@1/3/5/10、MRR
 *
 * 用法：
 *   node bench/eval-coderag.mjs <datasets_dir> [--sample 60] [--seed 20261120] [--limit 10] [--json-out f]
 *   --sample 0（默认）跑全部 373 条；抽样按仓库分层，同 seed 必得同一批 query
 *
 * 为什么不用 kb2 的 memory_search：这里要的是索引层（BM25 路）的纯检索数字，
 * 服务层还叠了去重与 limit 截断，会把 recall 口径搅浑。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const argv = process.argv.slice(2)
const get = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d }
const DATA = argv.find((a) => !a.startsWith('--') && !/^\d+$/.test(a))
if (!DATA) { console.error('用法：node bench/eval-coderag.mjs <datasets_dir> [--sample 60] [--seed 20261120] [--limit 10]'); process.exit(2) }
const SAMPLE = Number(get('sample', 0))
const SEED = Number(get('seed', 20261120))
const LIMIT = Number(get('limit', 10))
const VAULTROOT = get('vaults', '/tmp/coderag-vaults')

// 固定种子抽样（仓库分层 + 仓库内洗牌），同 seed 结果稳定
function rng(seed) { let s = seed | 1; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff }

const repos = execFileSync('bash', ['-lc', `ls -d ${DATA}/repoeval__* 2>/dev/null`], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
if (!repos.length) { console.error('找不到 repoeval__* 数据集目录'); process.exit(2) }

const built = {}
function ensureVault(repoDir) {
  const repo = path.basename(repoDir)
  const vault = join(VAULTROOT, repo)
  if (built[vault]) return vault
  mkdirSync(join(vault, 'code'), { recursive: true })
  const corpus = readFileSync(join(repoDir, 'corpus.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  // 清空重建（语料是只读的评测数据，删了能从 corpus.jsonl 再生成）
  rmSync(join(vault, 'code'), { recursive: true, force: true })
  mkdirSync(join(vault, 'code'), { recursive: true })
  const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120)
  const map = {}
  for (const doc of corpus) {
    const id = safe(doc._id)
    const code = doc.text || ''
    // 代码窗口按 ≤380 字分块、块间空行：kb2 的兜底段落切分要求 30–400 字，
    // 直接整段塞会把超过 400 字的窗口整条丢掉。
    // CHUNK=0：整窗一段（需要 MEM_BODY_MAX 放得下）；默认按 380 字切块
    let chunks
    if (process.env.CHUNK === '0') {
      chunks = [code]
    } else {
      chunks = []
      let cur = ''
      for (const line of code.split('\n')) {
        const next = cur ? cur + '\n' + line : line
        if (next.length > 380) { if (cur.trim()) chunks.push(cur); cur = line } else cur = next
      }
      if (cur.trim()) chunks.push(cur)
    }
    // SPLIT_IDS=1：入库前把标识符按 . 和 _ 拆开（`self.foo_bar` → `self foo bar`）。
    // kb2 的 tokenize 把 [a-z0-9._-] 连写视为一个整词，代码里的 `self.x` 与独立的 `self`
    // 因此互不命中；Lucene 默认会拆。这一步只动入库文本，不动内核分词。
    const norm = (c) => {
      let t = c.replace(/^---$/gm, '___')
      if (process.env.SPLIT_IDS === '1') t = t.replace(/[._]/g, ' ')
      return t
    }
    const body = chunks.map(norm).filter((c) => c.trim().length >= 30).join('\n\n')
    const md = ['---', `title: ${doc.title || id}`, 'kind: code', 'status: active', '---', '', body, ''].join('\n')
    writeFileSync(join(vault, 'code', id + '.md'), md, 'utf8')
    map[id] = doc._id
  }
  writeFileSync(join(vault, '_idmap.json'), JSON.stringify(map))
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'memory-index.mjs'), '--build'], { env: { ...process.env, MEM_VAULT: vault }, stdio: 'pipe' })
  built[vault] = { cards: corpus.length }
  return vault
}

// 抽样：仓库分层，按各仓库 query 数占比分配（至少 1 条）
const all = []
for (const r of repos) {
  const qs = readFileSync(join(r, 'queries.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  all.push({ repo: r, queries: qs })
}
let picked = null
if (SAMPLE > 0) {
  const rnd = rng(SEED)
  const total = all.reduce((s, x) => s + x.queries.length, 0)
  picked = []
  for (const x of all) {
    const share = Math.max(1, Math.round(SAMPLE * x.queries.length / total))
    const idx = x.queries.map((_, i) => i)
    for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]] }
    const take = new Set(idx.slice(0, share))
    picked.push({ repo: x.repo, queries: x.queries.filter((_, i) => take.has(i)) })
  }
} else picked = all

// MEM_VAULT 是模块级常量，多仓库必须每次重新加载模块（cache-busting query string）
const rows = []
let n = 0, mrr = 0, ndcgAll = 0
const agg = { 1: 0, 3: 0, 5: 0, 10: 0 }
for (const { repo, queries } of picked) {
  const vault = ensureVault(repo)
  process.env.MEM_VAULT = vault
  const { query } = await import(join(ROOT, 'src', 'index.mjs') + '?repo=' + encodeURIComponent(repo))
  const idmap = JSON.parse(readFileSync(join(vault, '_idmap.json'), 'utf8'))
  const qrels = {}
  for (const line of readFileSync(join(repo, 'qrels', 'test.tsv'), 'utf8').trim().split('\n').slice(1)) {
    const [qid, cid] = line.split('\t'); (qrels[qid] ||= new Set()).add(cid)
  }
  let rn = 0, rr = 0, ndcgSum = 0
  const a = { 1: 0, 3: 0, 5: 0, 10: 0 }
  for (const q of queries) {
    const rel = qrels[q._id]; if (!rel || !rel.size) continue
    rn++
    const tw = Number(process.env.TITLE_W || 0)
    const { ranked } = tw ? query(q.text, { limit: LIMIT, titleW: tw }) : query(q.text, { limit: LIMIT })
    const ids = ranked.map((r) => { const m = /code\/(.+)\.md$/.exec(r.path || ''); return m ? idmap[m[1]] : null }).filter(Boolean)
    const rank = ids.findIndex((id) => rel.has(id))
    // nDCG@10（二值相关性）：与 CodeRAG-Bench 论文 Table 2 的 RepoEval 列同口径
    let dcg = 0
    ids.slice(0, 10).forEach((id, i) => { if (rel.has(id)) dcg += 1 / Math.log2(i + 2) })
    let idcg = 0
    const ideal = Math.min(rel.size, 10)
    for (let i = 0; i < ideal; i++) idcg += 1 / Math.log2(i + 2)
    ndcgSum += idcg ? dcg / idcg : 0
    if (rank === 0) a[1]++
    if (rank >= 0 && rank < 3) a[3]++
    if (rank >= 0 && rank < 5) a[5]++
    if (rank >= 0) a[10]++
    rr += rank >= 0 ? 1 / (rank + 1) : 0
  }
  n += rn; mrr += rr
  for (const k of Object.keys(agg)) agg[k] += a[k]
  ndcgAll += ndcgSum
  rows.push({ repo: path.basename(repo), queries: rn, ndcg10: +(100 * ndcgSum / rn).toFixed(1), recall1: +(100 * a[1] / rn).toFixed(1), recall3: +(100 * a[3] / rn).toFixed(1), recall5: +(100 * a[5] / rn).toFixed(1), recall10: +(100 * a[10] / rn).toFixed(1), mrr: +(rr / rn).toFixed(3) })
}
const out = { data: DATA, sample: SAMPLE, seed: SEED, limit: LIMIT, total_queries: n,
  recall1: +(100 * agg[1] / n).toFixed(1), recall3: +(100 * agg[3] / n).toFixed(1),
  recall5: +(100 * agg[5] / n).toFixed(1), recall10: +(100 * agg[10] / n).toFixed(1),
  mrr: +(mrr / n).toFixed(3), ndcg10: +(100 * ndcgAll / n).toFixed(1), per_repo: rows }
console.log(JSON.stringify(out, null, 1))
const jo = get('json-out', null)
if (jo) writeFileSync(jo, JSON.stringify(out, null, 1))
