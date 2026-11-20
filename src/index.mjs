#!/usr/bin/env node
/**
 * memory-index.mjs — 记忆库 SQLite 索引层（可整库重建，不是真源）
 *
 * 真源永远是 vault 里的 Markdown。本脚本只做两件事：
 *   1) build：扫 vault（frontmatter v2 + atoms）→ SQLite 索引
 *   2) query：给一句话，返回命中的卡（原子级打分，卡级聚合）
 *
 * 为什么不用 FTS5（实测数据，2026-11-02）：
 *   - 默认 unicode61 把「中文分词测试」当**一个** token，查「分词」0 命中
 *   - trigram 分词器：三字「分词测」命中，两字「分词」仍然 0 命中
 *   中文两字词是死区 → 自己切 bigram 建倒排表，这一层可控且和现有 queryTerms 同源。
 *
 * 打分口径（与帖子作者那套的差别）：
 *   他用「命中词数 + 标签 IDF」，前提是原子 ≤60 字、词频恒为 1。
 *   本机原子 14–90 字、卡 2.7 KB，长度差异真实存在 → 用 BM25 变体：
 *   score = Σ idf(t) * tf*(k1+1) / (tf + k1*(1 - b + b*len/avglen))
 *   外加：标题命中的原子额外 ×1.3（标题是人工/模型都认可的概括）。
 *
 * 用法：
 *   node scripts/memory-index.mjs --build              # 重建索引
 *   node scripts/memory-index.mjs --query "手机连不上电脑" --limit 5
 *   node scripts/memory-index.mjs --stats
 */
import { DatabaseSync } from 'node:sqlite'
import { promises as fs, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

const VAULT = process.env.MEM_VAULT || path.join(os.homedir(), '.memory-vault')
const DB_PATH = process.env.MEM_INDEX || path.join(VAULT, '.index', 'memory.sqlite')
const STAMP_PATH = path.join(VAULT, '.index', '.last-sync')
const K1 = 1.2
const B = 0.75
// 标题权重默认值。控制变量实测（2026-11-13，工程 1235 篇 / wiki 941 卡）：
//   概念名查询：TW 1.0→2.0 时 recall@1 从 93.0%→99.6（工程）、80.1%→95.9（wiki）
//   描述性查询：TW 1.0 最优，3.0 时下降 3.4pp
// 调用方可按查询类型覆盖；默认取描述性场景的安全值。
const TITLE_W = 1.3
// 覆盖率因子：卡如果只命中查询里的一个泛词，分数打折。指数 0.35 是对中文短查询调的
// （工程库 59 条）。对代码/长 query（RepoEval 每条 20+ token）它会系统性压低整体匹配度，
// 2026-11-20 用 MEM_COVER_POW 做成参数，默认仍 0.35（不改旧行为）。
const COVER_POW = Number(process.env.MEM_COVER_POW ?? 0.35)
// 标题先验：标题命中的查询词比例越高，卡越可信（wiki bench 的「标题先验 + RRF」做法）。
// 实测（2026-11-13，工程库 32 条人工标注）：补上后 top1 从 81% → 88%。
const TITLE_PRIOR = Number(process.env.MEM_TITLE_PRIOR || 0)   // 乘法式标题先验；第 4 轮在“目标卡被 deleted 过滤”的前提下测过，需在有效候选上重测
// 标题路 RRF：把「标题覆盖率」当独立一路，与 BM25 名次融合（wiki bench 的 E 组做法）。
// 0 = 关闭（保持旧行为，便于 A/B）；>0 = 该路的 RRF 权重。
// BM25F：按 atom 的 nature 分字段（title / 正文）各自长度归一后加权，替代「title 分数乘系数」的近似。
// 第 13 轮零成本模拟：概念名查询 recall@1 66.2% → 83.7%（+17.5pp），描述性查询无变化。
// MEM_BM25F=1 启用；默认关，便于 A/B。
const BM25F = process.env.MEM_BM25F === '1'
const BM25F_W_TITLE = Number(process.env.MEM_BM25F_W_TITLE || 3.0)
const BM25F_W_BODY = Number(process.env.MEM_BM25F_W_BODY || 1.0)
const TITLE_ROUTE_W = Number(process.env.MEM_TITLE_ROUTE_W || 0)   // 实测：问题不在排序（失败题的目标卡是 deleted），保持 0
const TITLE_ROUTE_MIN_COV = Number(process.env.MEM_TITLE_ROUTE_MIN_COV || 0.3)

// ---- 分词 ----------------------------------------------------------------
// 正文里「答案型」小节：这些段落的检索价值高于叙述性正文。
// 2026-11-08 加：原先只索引 frontmatter 的 atoms，正文 88% 的内容检索不到（覆盖率 11.7%）。
// 正文「答案型」小节的词表。工程/聊天语域是默认值；法学卡的章节名是
// 体系位置 / 内容 / 类型·情形 / 效果 / 例外与争议 / 连线 / 溯源 / 待核实，
// 一条都不匹配默认词表 —— 这就是法学库 385 万字正文零入索引的根因（2026-11-20 实测：
// 941 卡只有 941 条 title 原子 + 7527 条 frontmatter 原子，b-/p- 前缀为 0）。
// MEM_BODY_SECTIONS 逗号分隔，按库注入；不设则保持原词表，行为不变。
const BODY_SECTIONS_RAW = (process.env.MEM_BODY_SECTIONS || '').trim()
const BODY_SECTIONS = BODY_SECTIONS_RAW
  ? new RegExp(`^(${BODY_SECTIONS_RAW.split(/[,，]/).map((x) => x.trim()).filter(Boolean).join('|')})`)
  : /^(排障|要点|结论|教训|根因|现象|原因|解决|修复|验证|注意|背景|方案|对比|步骤)/
const BODY_MIN = 30
const BODY_MAX = Number(process.env.MEM_BODY_MAX) || 400
// 法学卡的 [[物债二分]] 链接：17037 个链接名若原样入索引，会变成大量以链接名为 token 的
// 噪声（同一概念在每张卡里出现一次，idf 被压扁）。入索引前剥括号、保留锚文本。
const STRIP_WIKILINKS = process.env.MEM_STRIP_WIKILINKS !== '0'
const stripLinks = (t) => (STRIP_WIKILINKS ? t.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, a, b) => b || a) : t)

const STOP = new Set('的了是我在和有就都而及与着不也这那其等或从把被让给对为以中上下个人一'.split(''))
const CJK = /[\u4e00-\u9fff]/

// 切分方式（2026-11-20 加，用于 CodeRAG 与官方 BM25 对齐的实验）：
//   regex（默认）：现状，中文 bigram + ASCII 整词，纯数字丢弃
//   ws：按空白切分（对齐 pyserini 的 JWhiteSpaceAnalyzer），仍保留中文 bigram 与过滤规则
//   ws_raw：按空白切分且不过滤（最贴近 Lucene whitespace analyzer 的行为）
// 三种都用于 query 与文档两侧，与官方「索引 -pretokenized + 检索 JWhiteSpaceAnalyzer」同构。
const TOKENIZER = process.env.MEM_TOKENIZER || 'regex'

/** CJK 感知切词：中文连串 → bigram（+ 长度≤4 时补整串），英文数字 → 小写整词 */
export function tokenize(text) {
  const s = String(text || '').toLowerCase()
  const out = new Map()
  const add = (t, w = 1) => { if (!t) return; out.set(t, (out.get(t) || 0) + w) }
  const re = TOKENIZER === 'regex' ? /[\u4e00-\u9fff]+|[a-z0-9][a-z0-9._-]*/g : /\S+/g
  for (const m of s.matchAll(re)) {
    const tok = m[0]
    if (CJK.test(tok)) {
      if (tok.length === 1) { if (!STOP.has(tok)) add(tok); continue }
      for (let i = 0; i < tok.length - 1; i++) add(tok.slice(i, i + 2))
      if (tok.length <= 4) add(tok)
    } else if (TOKENIZER === 'ws_raw') {
      add(tok)
    } else {
      if (tok.length >= 2 && !/^\d+$/.test(tok)) add(tok)
    }
  }
  return out
}

// ---- 解析 Markdown -------------------------------------------------------
function parseCardFile(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!m) return null
  const fm = m[1]
  const lines = fm.split(/\r?\n/)
  const scalar = (key) => {
    for (const l of lines) {
      const eq = l.indexOf(':')
      if (eq <= 0) continue
      if (l.slice(0, eq).trim() === key) return l.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '')
    }
    return ''
  }
  const tags = (scalar('tags') || '').replace(/^\[|\]$/g, '').split(',').map((t) => t.trim()).filter(Boolean)
  // scope：跨域收窄用（belief 卡自带 domain:code / domain:writing / user:universal）。
  // 只做结构化读取，不在检索层猜测语义；不传 scope 时完全不过滤。
  const scopeRaw = scalar('scope') || ''
  const scope = scopeRaw.replace(/^\[|\]$/g, '').split(',').map((t) => t.trim()).filter(Boolean)

  // 原子块：只认我们自己的字段名（见 memory-migrate-v2.mjs 的注释）
  const atoms = []
  const am = /^atoms:\n([\s\S]*?)(?=^\S|$(?![\s\S]))/m.exec(fm)
  if (am) {
    let cur = null
    for (const line of am[1].split(/\r?\n/)) {
      const idM = /^ {2}- id:\s*(\S+)/.exec(line)
      if (idM) { if (cur) atoms.push(cur); cur = { id: idM[1], labels: [] }; continue }
      if (!cur) continue
      const kv = /^ {4}([a-zA-Z]+):\s*(.*)$/.exec(line)
      if (!kv) continue
      const [, k, vRaw] = kv
      const v = vRaw.replace(/^"(.*)"$/s, '$1').replace(/\\"/g, '"')
      if (k === 'labels') cur.labels = v.replace(/^\[|\]$/g, '').split(',').map((x) => x.trim()).filter(Boolean)
      else if (k === 'active') cur.active = v !== 'false'
      else if (k === 'conf') cur.conf = Number(v) || 0
      else cur[k] = v
    }
    if (cur) atoms.push(cur)
  }
  return {
    title: scalar('title') || scalar('card'),
    kind: scalar('kind'),
    status: scalar('status') || 'pending',
    tags,
    scope,
    atoms,
  }
}

// ---- 建库 ----------------------------------------------------------------
async function walk(dir, base = dir, acc = []) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (!['.git', '.index', 'node_modules'].includes(e.name)) await walk(p, base, acc) }
    else if (e.name.endsWith('.md')) acc.push(path.relative(base, p))
  }
  return acc
}

export async function build() {
  await fs.mkdir(path.dirname(DB_PATH), { recursive: true })
  await fs.rm(DB_PATH, { force: true })
  const db = new DatabaseSync(DB_PATH)
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE cards (id TEXT PRIMARY KEY, path TEXT, title TEXT, kind TEXT, status TEXT, mtime INTEGER, scope TEXT);
    CREATE TABLE atoms (id TEXT PRIMARY KEY, card_id TEXT, text TEXT, nature TEXT, subject TEXT,
                        active INTEGER, evidence TEXT, conf REAL, len INTEGER);
    CREATE TABLE postings (token TEXT, atom_id TEXT, tf INTEGER, PRIMARY KEY (token, atom_id));
    CREATE TABLE atom_tags (atom_id TEXT, tag TEXT);
    CREATE INDEX idx_postings_token ON postings(token);
    CREATE INDEX idx_atoms_card ON atoms(card_id);
  `)
  const files = await walk(VAULT)
  const insCard = db.prepare('INSERT OR REPLACE INTO cards (id,path,title,kind,status,mtime,scope) VALUES (?,?,?,?,?,?,?)')
  const insAtom = db.prepare('INSERT OR REPLACE INTO atoms VALUES (?,?,?,?,?,?,?,?,?)')
  const insPost = db.prepare('INSERT OR REPLACE INTO postings VALUES (?,?,?)')
  const insTag = db.prepare('INSERT OR REPLACE INTO atom_tags VALUES (?,?)')

  let nCards = 0, nAtoms = 0, nPost = 0
  db.exec('BEGIN')
  for (const rel of files) {
    let text
    try { text = await fs.readFile(path.join(VAULT, rel), 'utf8') } catch { continue }
    const card = parseCardFile(text)
    if (!card) continue
    const cid = crypto.createHash('sha1').update(rel).digest('hex').slice(0, 12)
    const st = await fs.stat(path.join(VAULT, rel))
    insCard.run(cid, rel, card.title, card.kind, card.status, Math.round(st.mtimeMs), (card.scope || []).join(','))
    nCards++
    // 标题原子：标题是人/模型都认可的概括，单列一条保证可检索
    {
      const tid = 't-' + cid
      const len = (card.title || '').length
      if (len) {
        insAtom.run(tid, cid, card.title, 'title', 'card', card.status === 'deleted' ? 0 : 1, '', 1, len)
        nAtoms++
        for (const [tok, tf] of tokenize(card.title)) { insPost.run(tok, tid, tf); nPost++ }
      }
    }
    for (const a of card.atoms) {
      if (!a.text) continue
      const len = a.text.length
      insAtom.run(a.id, cid, a.text, a.nature || 'fact', a.subject || 'knowledge',
        a.active === false ? 0 : 1, a.evidence || '', a.conf || 0, len)
      nAtoms++
      for (const [tok, tf] of tokenize(a.text)) { insPost.run(tok, a.id, tf); nPost++ }
      for (const t of a.labels || []) insTag.run(a.id, t)
    }
    // 正文的「答案型」小节也入库：同一张卡里再切一份段落级原子，
    // id 前缀 b- 与 frontmatter 原子区分，重排与输出时可直接引用。
    let nBodyAtom = 0
    {
      const bodyRaw = text.split(/^---$/m).slice(2).join('')
      let inTarget = false
      for (const line of bodyRaw.split('\n')) {
        const h = /^#{2,3}\s+(.+)$/.exec(line.trim())
        if (h) { inTarget = BODY_SECTIONS.test(h[1].trim()); continue }
        if (!inTarget) continue
        const seg = stripLinks(line.trim())
        if (seg.length < BODY_MIN || seg.length > BODY_MAX) continue
        const bid = 'b-' + crypto.createHash('sha1').update(rel + '|' + seg).digest('hex').slice(0, 10)
        insAtom.run(bid, cid, seg, 'body', 'body', 1, '', 0.6, seg.length)
        nAtoms++; nBodyAtom++
        for (const [tok, tf] of tokenize(seg)) { insPost.run(tok, bid, tf); nPost++ }
      }
    }
    // 兜底：没有 atoms、也没有命中答案型小节的卡（例如 wiki 概念卡的
    // 「card: 概念名 + 自由正文」格式），按空行切段落入索引，
    // 否则这类卡只有标题可检索、正文字段为空，BM25F 无从加权。
    if (!card.atoms.length && nBodyAtom === 0) {
      const bodyRaw = text.split(/^---$/m).slice(2).join('')
      // 整卡入库 vs 按空行切段落。
      //
      // 代码卡片（kind: code）必须整卡入库：代码没有 Markdown 小节，会落进这条兜底路径，
      // 而按空行切会把一个 function 拆成平均 11.6 个段落原子。原子级 BM25 的后果是三重的——
      // 长度归一化基准从「函数」变成「段落」、tf 不跨段累加、idf 的 N 从文档数变成原子数（差 11.6 倍）。
      // 2026-11-20 在 CodeRAG-Bench RepoEval（373 条）实测：
      //   默认（空行切段）nDCG@10 = 87.5；整卡入库（+空白分词+关覆盖率折扣）= 93.2，
      //   与论文 Table 3 的 BM25 基线 93.2 持平。整卡入库这一步单独贡献 +3.2pp（90.0 → 93.2）。
      // 卡片语料（knowledge/mistake/tool/...）不受影响：它们有 Markdown 小节，不走这条路径；
      // 实测把 MEM_BODY_WHOLE=1 强加到生产库会让 top3 从 100% 掉到 98.3%，所以只对 kind: code 生效。
      // MEM_BODY_WHOLE=1 仍保留为强制开关，供无小节结构的其他纯文本文料使用（会伤害卡片语料）。
      const wholeBody = process.env.MEM_BODY_WHOLE === '1' || card.kind === 'code'
      // 整卡入库时放宽长度上限，否则超过 BODY_MAX(400) 的函数会被整条丢掉。
      const maxLen = wholeBody ? Math.max(BODY_MAX, 200000) : BODY_MAX
      const paras = wholeBody ? [bodyRaw] : bodyRaw.split(/\n\s*\n/)
      for (const para of paras) {
        const seg = stripLinks(para.replace(/^#{1,6}\s+.*$/gm, ' ').replace(/\s+/g, ' ').trim())
        if (seg.length < BODY_MIN || seg.length > maxLen) continue
        const bid = 'p-' + crypto.createHash('sha1').update(rel + '|' + seg).digest('hex').slice(0, 10)
        insAtom.run(bid, cid, seg, 'body', 'body', 1, '', 0.6, seg.length)
        nAtoms++
        for (const [tok, tf] of tokenize(seg)) { insPost.run(tok, bid, tf); nPost++ }
      }
    }
  }
  db.exec('COMMIT')
  // 统计表（avgdl 用）
  const avg = db.prepare('SELECT AVG(len) v FROM atoms').get()?.v || 1
  db.exec(`CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT)`)
  db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run('avgdl', String(avg))
  db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run('built_at', new Date().toISOString())
  db.close()
  // 新鲜度标记：memory-server 的 ensureFresh 拿它跟卡片 mtime 比。缺了它，新建的库会被
  // 误判成「落后 56 年」并触发一次无用的后台同步（2026-11-14 实测踩到）。
  try {
    await fs.mkdir(path.dirname(STAMP_PATH), { recursive: true })
    await fs.writeFile(STAMP_PATH, String(Date.now()), 'utf8')
  } catch {}
  return { nCards, nAtoms, nPost, avg }
}

// ---- 查询 ----------------------------------------------------------------
export function openIndex() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true })
  const avgdl = Number(db.prepare("SELECT v FROM meta WHERE k='avgdl'").get()?.v) || 1
  const N = db.prepare('SELECT COUNT(*) c FROM atoms').get()?.c || 0
  return { db, avgdl, N }
}

/**
 * 卡片总数——供调用方按「库的规模」决定候选深度（自适应候选池，第 19 轮）。
 * 默认含归档卡（status: deleted）：它们不进检索结果，但占语料规模，规模估计用全量更稳。
 */
export function countCards({ includeDeleted = true } = {}) {
  const db = new DatabaseSync(DB_PATH, { readOnly: true })
  try {
    const sql = includeDeleted
      ? 'SELECT COUNT(*) c FROM cards'
      : "SELECT COUNT(*) c FROM cards WHERE COALESCE(status,'') != 'deleted'"
    return db.prepare(sql).get()?.c || 0
  } finally { db.close() }
}

/** @returns {{ranked: Array<{cardId,path,title,score,atom,hitTokens}>, stats}} */
/** scope 过滤：只在显式传入且索引有 scope 列时生效，否则返回 null（不过滤）。
 *  2026-11-20 之前建的索引没有 scope 列，这里静默降级——加字段不改旧库行为。 */
function resolveScope(db, scope) {
  const list = Array.isArray(scope) ? scope.map((x) => String(x).trim()).filter(Boolean) : []
  if (!list.length) return null
  try {
    const has = db.prepare("SELECT COUNT(*) c FROM pragma_table_info('cards') WHERE name = 'scope'").get().c > 0
    return has ? list : null
  } catch { return null }
}

export function query(q, { limit = 10, minScore = 0, includeDeleted = false, activeOnly = !includeDeleted, titleW = TITLE_W, k1 = K1, b = B, titlePrior = TITLE_PRIOR, scope = null } = {}) {
  const { db, avgdl, N } = openIndex()
  const terms = [...tokenize(q).keys()]
  if (!terms.length) { db.close(); return { ranked: [], stats: { terms: 0 } } }
  const ph = terms.map(() => '?').join(',')
  const scopeList = resolveScope(db, scope)
  const scopeClause = scopeList
    ? ` AND c.scope IS NOT NULL AND c.scope != '' AND (${scopeList.map(() => 'c.scope LIKE ?').join(' OR ')})`
    : ''
  const scopeArgs = scopeList ? scopeList.map((x) => `%${x}%`) : []
  const rows = db.prepare(`
    SELECT p.token, p.tf, p.atom_id, a.card_id, a.text, a.len, a.nature
    FROM postings p JOIN atoms a ON a.id = p.atom_id
      LEFT JOIN cards c ON c.id = a.card_id
    WHERE p.token IN (${ph}) ${activeOnly ? 'AND a.active = 1' : ''}
      ${includeDeleted ? '' : "AND COALESCE(c.status,'') != 'deleted'"}${scopeClause}
  `).all(...terms, ...scopeArgs)
  const df = db.prepare(`SELECT token, COUNT(DISTINCT atom_id) df FROM postings WHERE token IN (${ph}) GROUP BY token`).all(...terms)
  const dfMap = new Map(df.map((r) => [r.token, r.df]))
  const idf = (t) => Math.log((N - (dfMap.get(t) || 0) + 0.5) / ((dfMap.get(t) || 0) + 0.5) + 1)

  const perAtom = new Map()
  if (BM25F) {
    // 分字段打分：先按 (token, 卡) 聚合 title/正文的加权 tf，再统一进饱和函数
    const lens = new Map()
    for (const x of db.prepare('SELECT card_id, nature, SUM(len) s FROM atoms GROUP BY card_id, nature').all()) {
      const cur = lens.get(x.card_id) || { t: 0, b: 0 }
      if (x.nature === 'title') cur.t += x.s
      else cur.b += x.s
      lens.set(x.card_id, cur)
    }
    let sumT = 0, sumB = 0
    for (const v of lens.values()) { sumT += v.t; sumB += v.b }
    const nCard = Math.max(1, lens.size)
    const avgT = sumT / nCard || 1
    const avgB = sumB / nCard || 1
    const perCardTok = new Map()
    for (const r of rows) {
      const key = r.card_id + '|' + r.token
      const cur = perCardTok.get(key) || { cardId: r.card_id, token: r.token, tt: 0, tb: 0, text: r.text, nature: r.nature }
      if (r.nature === 'title') cur.tt += r.tf
      else cur.tb += r.tf
      perCardTok.set(key, cur)
    }
    for (const cur of perCardTok.values()) {
      const L = lens.get(cur.cardId) || { t: 0, b: 0 }
      const tfw = BM25F_W_TITLE * cur.tt / (1 - b + b * (L.t || 1) / avgT)
        + BM25F_W_BODY * cur.tb / (1 - b + b * (L.b || 1) / avgB)
      if (tfw <= 0) continue
      const dfv = dfMap.get(cur.token) || 0
      const idf = Math.log((N - dfv + 0.5) / (dfv + 0.5) + 1)
      const w = idf * (tfw * (k1 + 1)) / (tfw + k1)
      // BM25F：同一张卡的多个查询词分数必须累加（BM25 是 Σ over terms），不能按卡取最大
      const prev = perAtom.get(cur.cardId) || { atomId: 'f-' + cur.cardId, cardId: cur.cardId, text: cur.text, nature: cur.nature, score: 0, hits: 0 }
      prev.score += w
      prev.hits += 1
      perAtom.set(cur.cardId, prev)
    }
  }
  for (const r of rows) {
    if (BM25F) break
    let w = idf(r.token) * (r.tf * (k1 + 1)) / (r.tf + k1 * (1 - b + b * r.len / avgdl))
    if (r.nature === 'title') w *= titleW   // 标题加权：概念名查询需要高、描述性查询需要低（实测见 docs）
    const cur = perAtom.get(r.atom_id) || { atomId: r.atom_id, cardId: r.card_id, text: r.text, nature: r.nature, score: 0, hits: 0 }
    cur.score += w
    cur.hits += 1
    perAtom.set(r.atom_id, cur)
  }
  // 卡级聚合：同一张卡取最高分原子
  // 覆盖率：命中多少个查询词 / 查询词总数。不惩罚会让「命中一个泛词」的卡虚高。
  const cover = (hits) => (COVER_POW > 0 ? Math.pow(hits / Math.max(terms.length, 1), COVER_POW) : 1)
  for (const a of perAtom.values()) a.score *= cover(a.hits)
  // 标题覆盖率：这张卡的标题原子命中了多少个不同的查询词
  const titleTok = new Map()
  for (const r of rows) {
    if (r.nature !== 'title') continue
    let set = titleTok.get(r.card_id)
    if (!set) { set = new Set(); titleTok.set(r.card_id, set) }
    set.add(r.token)
  }
  const perCard = new Map()
  for (const a of perAtom.values()) {
    const prev = perCard.get(a.cardId)
    if (!prev || a.score > prev.score) perCard.set(a.cardId, { ...a, atomCount: (prev?.atomCount || 0) + 1 })
  }
  if (titlePrior > 0) {
    for (const c of perCard.values()) {
      const cov = (titleTok.get(c.cardId)?.size || 0) / Math.max(1, terms.length)
      if (cov > 0) c.score *= 1 + titlePrior * cov
    }
  }
  const meta = new Map(db.prepare('SELECT id, path, title, kind FROM cards').all().map((c) => [c.id, c]))
  // 标题路：按标题原子命中的查询词覆盖率排序，与 BM25 名次做 RRF（名次融合，不用系数乘法）
  if (TITLE_ROUTE_W > 0) {
    const bmOrder = [...perCard.values()].sort((a, b) => b.score - a.score)
    const bmIdx = new Map(bmOrder.map((c, i) => [c.cardId, i]))
    const titleOrder = [...titleTok.entries()]
      .map(([cid, set]) => ({ cid, cov: set.size / Math.max(1, terms.length) }))
      .filter((x) => x.cov >= TITLE_ROUTE_MIN_COV)
      .sort((a, b) => b.cov - a.cov)
    const titleIdx = new Map(titleOrder.map((x, i) => [x.cid, i]))
    for (const c of perCard.values()) {
      const bi = bmIdx.get(c.cardId) ?? 999
      const ti = titleIdx.get(c.cardId)
      c.rrf = 1 / (60 + bi + 1) + (ti === undefined ? 0 : TITLE_ROUTE_W / (60 + ti + 1))
    }
  }
  const ranked = [...perCard.values()]
    .map((c) => ({ ...c, path: meta.get(c.cardId)?.path || '', title: meta.get(c.cardId)?.title || '', kind: meta.get(c.cardId)?.kind || '' }))
    .filter((c) => c.score >= minScore)
    .sort((a, b) => (TITLE_ROUTE_W > 0 ? (b.rrf ?? 0) - (a.rrf ?? 0) : b.score - a.score))
    .slice(0, limit)
  db.close()
  return { ranked, stats: { terms: terms.length, candidateAtoms: perAtom.size, N } }
}

// ---- CLI -----------------------------------------------------------------
async function main() {
  const argv = process.argv.slice(2)
  const get = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d }
  if (argv.includes('--build')) {
    const r = await build()
    console.log(`索引已建：${r.nCards} 卡 / ${r.nAtoms} 原子 / ${r.nPost} 倒排项，avgdl=${r.avg.toFixed(1)}`)
    console.log(`位置：${DB_PATH}（可随时删除重建）`)
    return
  }
  if (argv.includes('--query')) {
    const q = get('query', '')
    const limit = Number(get('limit', 5))
    const { ranked, stats } = query(q, { limit })
    console.log(`查询「${q}」 切词 ${stats.terms} 个，候选原子 ${stats.candidateAtoms}/${stats.N}`)
    ranked.forEach((r, i) => console.log(`  ${i + 1}. [${r.score.toFixed(2)}] ${r.title.slice(0, 40)}\n     原子：${r.text.slice(0, 60)}`))
    if (!ranked.length) console.log('  无命中')
    return
  }
  if (argv.includes('--stats')) {
    const { db, N, avgdl } = openIndex()
    const c = db.prepare('SELECT COUNT(*) c FROM cards').get().c
    const p = db.prepare('SELECT COUNT(*) c FROM postings').get().c
    console.log(`卡 ${c} / 原子 ${N} / 倒排项 ${p} / avgdl ${avgdl.toFixed(1)}`)
    db.close()
    return
  }
  console.log('用法：--build | --query "..." [--limit 5] | --stats')
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1) })


// ---- 向量层（可选，存在才用） --------------------------------------------
// 向量缓存：memory-server 是长驻进程，每次查询都重读 20+MB 文件是纯浪费。
// 用 (json 路径 + f32 的 mtime/size) 做键，重建索引后自动失效。
let _vecCache = null
let _vecKey = null

export function loadVectors() {
  const dir = path.join(VAULT, '.index')
  try {
    const jp = path.join(dir, 'vectors.json')
    const fp = path.join(dir, 'vectors.f32')
    const st = statSync(fp)
    const key = `${jp}:${st.mtimeMs}:${st.size}`
    if (_vecCache && _vecKey === key) return _vecCache
    const meta = JSON.parse(readFileSync(jp, 'utf8'))
    const buf = readFileSync(fp)
    const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
    const out = { f32, dim: meta.dim, n: meta.count, ids: meta.ids, model: meta.model }
    _vecCache = out
    _vecKey = key
    return out
  } catch { return null }
}

/** 余弦 top-k（向量已 normalize，点积即余弦） */
export function vectorTopK(qvec, v, k = 100) {
  const { f32, dim, n, ids } = v
  const scored = []
  for (let i = 0; i < n; i++) {
    let s = 0
    const off = i * dim
    for (let d = 0; d < dim; d++) s += qvec[d] * f32[off + d]
    scored.push([s, i])
  }
  scored.sort((a, b) => b[0] - a[0])
  return scored.slice(0, k).map(([score, i]) => ({ atomId: ids[i], score }))
}

/** Reciprocal Rank Fusion：多路检索结果按名次融合，不需要分数可比 */
export function rrf(lists, k = 60) {
  const acc = new Map()
  for (const list of lists) {
    list.forEach((item, i) => {
      const key = item.atomId || item.cardId
      const cur = acc.get(key) || { key, score: 0, item }
      cur.score += 1 / (k + i + 1)
      acc.set(key, cur)
    })
  }
  return [...acc.values()].sort((a, b) => b.score - a.score)
}


/**
 * 混合检索：BM25 卡级序列 + 向量原子级序列 → RRF → 卡级结果
 * qvec 由调用方提供（embedding 模型不塞进本文件，保持零依赖可单独运行）
 */
/**
 * 查询类型路由：技术型查询（含英文标识/版本号/错误码/命令语）里 BM25 的精确命中更可信；
 * 纯中文口语描述里语义向量更可信。用权重而不是二选一，避免任一路彻底失效时结果塌掉。
 */
export function classifyQuery(q) {
  const tech = /[A-Za-z][A-Za-z0-9_.-]{2,}|\d+\.\d+|\b[0-9]{3,4}\b|错误|报错|命令|端口|路径|配置项/.test(q)
  return tech ? 'tech' : 'semantic'
}

export function hybridQuery(q, { limit = 5, qvec = null, k = 60, weights = null, titleW = TITLE_W, k1 = K1, b = B, includeDeleted = false, bm25Query = null, scope = null } = {}) {
  // bm25Query：抽取式改写只作用在词法这一路，向量路仍用原 query。
  // 理由：改写会引入原句没有的词，拿它去算 embedding 等于让改写污染语义检索；
  // 而 BM25 本来就是词面匹配，别名扩展（k8s → kubernetes）正是它需要的。
  const bm = query(bm25Query || q, { limit: 200, includeDeleted, titleW, k1, b, scope })
  const lists = [bm.ranked.map((h) => ({ cardId: h.cardId }))]
  // 记录每张卡命中的原子，供输出层展示「为什么匹配」。
  const hitsByCard = new Map()
  const noteHit = (cid, aid) => {
    if (!cid || !aid) return
    const set = hitsByCard.get(cid) || new Set()
    set.add(aid)
    hitsByCard.set(cid, set)
  }
  for (const h of bm.ranked) noteHit(h.cardId, h.atomId)
  if (qvec) {
    const v = loadVectors()
    if (v) {
      const hits = vectorTopK(qvec, v, 200)
      const db = new DatabaseSync(DB_PATH, { readOnly: true })
      // 向量路同样要过 scope：否则融合会把 scope 外的卡从 dense 一路带回来，
      // BM25 那路过滤就白做了。
      const vScope = resolveScope(db, scope)
      let vSql = 'SELECT a.id, a.card_id FROM atoms a LEFT JOIN cards c ON c.id = a.card_id WHERE 1=1'
      const vArgs = []
      if (!includeDeleted) vSql += " AND COALESCE(c.status,'') != 'deleted'"
      if (vScope) {
        vSql += ` AND c.scope IS NOT NULL AND c.scope != '' AND (${vScope.map(() => 'c.scope LIKE ?').join(' OR ')})`
        vArgs.push(...vScope.map((x) => `%${x}%`))
      }
      const atomCard = new Map(db.prepare(vSql).all(...vArgs).map((r) => [r.id, r.card_id]))
      db.close()
      const seen = new Set()
      const seq = []
      for (const h of hits) {
        const cid = atomCard.get(h.atomId)
        if (cid && !seen.has(cid)) { seen.add(cid); seq.push({ cardId: cid }); noteHit(cid, h.atomId) }
      }
      lists.push(seq)
    }
  }
  // 实测否定了「按查询类型加权」：tech 1.0/0.6、semantic 0.6/1.0 在 17 条评测上
  // recall@5 从 7/17 掉到 6/17（2026-11-02）。保持等权，除非以后有更大样本支持。
  const kind = classifyQuery(q)
  const w = weights || [1.0, 1.0]
  const acc = new Map()
  lists.forEach((list, wi) => {
    const weight = w[wi] ?? 1
    list.forEach((item, i) => {
      const cur = acc.get(item.cardId) || { cardId: item.cardId, score: 0 }
      cur.score += weight / (k + i + 1)
      acc.set(item.cardId, cur)
    })
  })
  const top = [...acc.values()].sort((a, b) => b.score - a.score).slice(0, limit)
  const db = new DatabaseSync(DB_PATH, { readOnly: true })
  const info = new Map(db.prepare('SELECT id, path, title, kind FROM cards').all().map((r) => [r.id, r]))
  const atomRows = db.prepare("SELECT id, card_id, text, nature FROM atoms WHERE nature != 'title'").all()
  const atomText = new Map(atomRows.map((r) => [r.card_id, r.text]))
  const atomInfo = new Map(atomRows.map((r) => [r.id, { text: r.text, nature: r.nature }]))
  db.close()
  return {
    mode: qvec ? `hybrid(rrf,${kind})` : 'bm25',
    ranked: top.map((t) => ({
      ...(info.get(t.cardId) || {}),
      cardId: t.cardId,
      score: t.score,
      text: atomText.get(t.cardId) || '',
      hitAtoms: [...(hitsByCard.get(t.cardId) || [])].map((id) => atomInfo.get(id)).filter(Boolean).slice(0, 5),
    })),
  }
}
