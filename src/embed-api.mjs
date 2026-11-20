/**
 * embed-api.mjs — 通义千问（阿里云百炼）向量化与重排的 HTTP 适配层
 *
 * 替代本地 ONNX 推理。三个必须处理对的点：
 *   1) 批量去重：API 会对完全相同的文本去重，返回条数可能少于输入。
 *      这里自己做去重、按唯一文本回填，并要求"返回条数 === 送出条数"，不符就报错，
 *      不允许静默错位。
 *   2) 失败可见：记录最近一次调用的状态码与原因，供 memory_stats 直接显示。
 *   3) 单次超时 + 一次重试：网络抖动不应把整条检索链路打挂。
 *
 * 凭据顺序：环境变量 ALI_API_KEY → DASHSCOPE_API_KEY → ~/.dsh-web-lab/.credentials.yaml 的 refs 段。
 * 模型：EMBED_API_MODEL / RERANK_API_MODEL / EMBED_API_DIM 可覆盖。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const BASE = process.env.DASHSCOPE_BASE || 'https://dashscope.aliyuncs.com'
const CRED_FILE = process.env.DSH_CREDENTIALS || path.join(os.homedir(), '.dsh-web-lab/.credentials.yaml')

// 2026-11-20：模型名与维度统一走 src/constants.mjs（唯一真源）。
// 注意必须「先 import 再 re-export」，单独的 `export { X } from` 不会在本模块
// 内建立绑定，本文件后面的代码用 X 会 ReferenceError。
import { EMBED_MODEL, EMBED_DIM } from './constants.mjs'
export { EMBED_MODEL, EMBED_DIM }
export const RERANK_MODEL = process.env.RERANK_API_MODEL || 'qwen3.7-text-rerank'
const BATCH = Number(process.env.EMBED_API_BATCH) || 10   // 百炼同步接口单次上限 10 行

export class ApiError extends Error {
  constructor(message, status = 0) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

let _key
export function apiKey() {
  if (_key !== undefined) return _key
  for (const env of ['ALI_API_KEY', 'DASHSCOPE_API_KEY']) {
    const v = (process.env[env] || '').trim()
    if (v) { _key = v; return _key }
  }
  try {
    const t = readFileSync(CRED_FILE, 'utf8')
    const refs = t.includes('\nrefs:') ? t.split('\nrefs:')[1].split(/\n\w/)[0] : t
    const m = refs.match(/^\s*(?:ALI_API_KEY|DASHSCOPE_API_KEY):\s*(\S+)/m)
    if (m) { _key = m[1].replace(/^["']|["']$/g, ''); return _key }
  } catch {}
  _key = null
  return _key
}

export const state = {
  calls: 0, ok: 0, fail: 0,
  lastStatus: null, lastError: null, lastAt: null, lastMs: null,
}

export function apiStatus() {
  const hasKey = Boolean(apiKey())
  return {
    available: !hasKey ? 'no-key' : state.calls === 0 ? 'untested' : state.fail === 0 ? 'ok' : 'degraded',
    hasKey,
    calls: state.calls, ok: state.ok, fail: state.fail,
    lastStatus: state.lastStatus, lastError: state.lastError,
    lastMs: state.lastMs,
    lastAt: state.lastAt ? new Date(state.lastAt).toISOString().slice(0, 19).replace('T', ' ') : null,
    embedModel: EMBED_MODEL, rerankModel: RERANK_MODEL, dim: EMBED_DIM,
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 归一到单位长度，保证 hybridQuery 里的点积等价于余弦（API 实测范数 1.0001，仍需抹平误差） */
function normalize(v) {
  let s = 0
  for (const x of v) s += x * x
  const n = Math.sqrt(s)
  if (!(n > 0)) return v
  const out = new Array(v.length)
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n
  return out
}

async function post(url, body, { timeoutMs = 30_000, retries = 1 } = {}) {
  const key = apiKey()
  if (!key) throw new ApiError('缺少 ALI_API_KEY（环境变量或 .credentials.yaml 均未找到）', 0)

  let lastErr
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    const t0 = Date.now()
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })
      const txt = await r.text()
      let json = null
      try { json = JSON.parse(txt) } catch {}
      if (!r.ok) {
        const msg = (json?.message || json?.error?.message || txt || '').toString().slice(0, 160)
        const err = new ApiError(msg || `HTTP ${r.status}`, r.status)
        // 4xx（除 429）重试无意义，直接抛
        if (r.status !== 429 && r.status < 500) throw err
        lastErr = err
        if (attempt < retries) { await sleep(400 * (attempt + 1)); continue }
        throw err
      }
      state.calls++
      state.ok++
      state.fail = 0
      state.lastStatus = r.status
      state.lastError = null
      state.lastMs = Date.now() - t0
      state.lastAt = Date.now()
      return json
    } catch (e) {
      if (e instanceof ApiError && e.status && e.status !== 429 && e.status < 500) {
        state.calls++; state.fail++; state.lastStatus = e.status; state.lastError = e.message.slice(0, 160); state.lastAt = Date.now()
        throw e
      }
      lastErr = e
      if (attempt < retries) { await sleep(400 * (attempt + 1)); continue }
      state.calls++; state.fail++; state.lastStatus = 0
      state.lastError = String(e?.message || e).slice(0, 160); state.lastAt = Date.now()
      throw e
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastErr
}

/**
 * 批量向量化。返回与输入等长的数组，顺序严格对应。
 * 内部先按唯一文本去重再编码，节省 token；返回条数与送出条数必须相等，否则报错。
 */
export async function embed(texts, { timeoutMs = 30_000 } = {}) {
  const arr = texts.map((t) => String(t ?? ''))
  if (!arr.length) return []
  const uniq = [...new Set(arr)]
  const vec = new Map()
  for (let i = 0; i < uniq.length; i += BATCH) {
    const batch = uniq.slice(i, i + BATCH)
    const json = await post(`${BASE}/compatible-mode/v1/embeddings`, {
      model: EMBED_MODEL,
      input: batch,
      dimensions: EMBED_DIM,
      encoding_format: 'float',
    }, { timeoutMs })
    const data = json?.data || []
    if (data.length !== batch.length) {
      throw new ApiError(`向量返回条数不符：送出 ${batch.length}，返回 ${data.length}（不允许按位置猜）`, 0)
    }
    data.forEach((d, k) => {
      // 兼容端点按输入顺序返回；有 index 时以 index 为准
      const pos = typeof d.index === 'number' && d.index < batch.length ? d.index : k
      vec.set(batch[pos], normalize(d.embedding))
    })
    if (batch.some((b) => !vec.get(b))) throw new ApiError('向量返回缺失（去重后仍缺项）', 0)
  }
  return arr.map((t) => vec.get(t))
}

export async function embedOne(text, opts) {
  const [v] = await embed([text], opts)
  return v
}

/**
 * 批量重排：一次请求传完全部候选，返回按分数降序的 [{index, score}]。
 * index 对应传入 documents 的下标。
 */
export async function rerank(query, documents, { topN, timeoutMs = 30_000, withUsage = false } = {}) {
  const docs = documents.map((d) => String(d ?? ''))
  if (!docs.length) return withUsage ? { results: [], usage: null } : []
  const json = await post(`${BASE}/api/v1/services/rerank/text-rerank/text-rerank`, {
    model: RERANK_MODEL,
    input: { query: String(query ?? ''), documents: docs },
    parameters: { return_documents: false, top_n: Math.min(topN ?? docs.length, docs.length) },
  }, { timeoutMs })
  const results = (json?.output?.results || [])
    .map((r) => ({ index: r.index, score: Number(r.relevance_score) }))
    .sort((a, b) => b.score - a.score)
  return withUsage ? { results, usage: json?.usage || null } : results
}
