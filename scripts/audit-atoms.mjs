#!/usr/bin/env node
/**
 * 原子质量审计（纯正则，不调模型）
 *
 * 机制来源：LMC-5 `atom_quality.py` —— 三分类 pass / too_coarse / needs_rewrite，
 * 全正则判定，只用于 dry-run 审计与 CI fixture，**不用于生产判定**。
 *
 * 为什么不做自动改写：正则判得出「这条写得不好」，判不出「应该怎么改」。
 * 自动改写要用模型，而模型改写会引入对话里没有的表述（沉淀提示词里明令禁止）。
 * 所以这里只出报告，改不改由人定。
 *
 * 计数口径：中文按字符（汉字）计，不按空格分词——LMC-5 特别标注过这一条，
 * 按空格会给中文原子算出接近 0 的长度。
 *
 * 用法：
 *   node scripts/audit-atoms.mjs                      # 审计生产库
 *   node scripts/audit-atoms.mjs --vault <路径>
 *   node scripts/audit-atoms.mjs --json               # 机器可读
 *   node scripts/audit-atoms.mjs --only pending       # 只看 pending 卡的原子
 *   node scripts/audit-atoms.mjs --samples 20         # 每类样本数（默认 8）
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { resolveVault } from '../src/paths.mjs'

// 被 import（测试）时只导出 classifyAtom，不跑主流程
const IS_MAIN = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])

const argv = IS_MAIN ? process.argv.slice(2) : []
const has = (f) => argv.includes(f)
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d }

const VAULT = val('--vault', resolveVault())
const DB = path.join(VAULT, '.index', 'memory.sqlite')
const JSON_OUT = has('--json')
const ONLY = val('--only', null)      // pending / approved / 空=全部非 deleted
const SAMPLES = Number(val('--samples', 8)) || 8

if (IS_MAIN && !existsSync(DB)) {
  console.error(`索引不存在：${DB}\n先跑 npm run sync`)
  process.exit(2)
}

// ---- 判定规则 -------------------------------------------------------------
// 每条规则都要能指向一个具体毛病，且能给出「为什么」。规则越多越容易误判，
// 所以只收三类真问题：长度、半截句、清单当成句子。

const CJK = /[\u4e00-\u9fff]/g
const ARROW = /[→←↑↓]/
const LIST_HEAD = /^\s*(?:[-*•·]|\d+[.、)]|[（(]\d+[）)]|[①-⑳])/
// 「的」结尾不判半截句：中文「是…的」判断句极常见（「不是本地改的」「主因是端口没传」），
// 把它当半截句会大面积误伤。只判标点结尾与虚词连接结尾。
const HALF_TAIL = /[与和或、，,：:；;]$/
// 标题清单必须冒号前是「短语」：冒号前 ≤10 字且不含判断动词。
// 否则「它同时承载：邮箱根、身份根、服务根」这种完整句会被误判成清单。
const TITLE_LIST = /^([^：:]{1,10})[：:]\s*\S+、\S+、\S+/
const VERB_IN_HEAD = /[是有要需会能该应为把对在]|包括|承载|包含|分为|属于/
const MULTI_CLAUSE = /[；;]/g

function hanCount(s) {
  return (String(s).match(CJK) || []).length
}

/**
 * @returns {{verdict:'pass'|'too_coarse'|'needs_rewrite', reasons:string[]}}
 */
export function classifyAtom(text, { nature = 'fact' } = {}) {
  const t = String(text || '').trim()
  const reasons = []
  const len = [...t].length          // 按字符（含汉字），不按空格
  const han = hanCount(t)

  // too_coarse：一条原子塞了太多东西，摘出来看不出是哪件事
  if (len > 120) reasons.push(`too-long(${len}>120)`)
  // 多段并列：一个原子塞 3 段以上，摘出来看不出是哪件事。
  // 阈值 50 字而不是 80——实测「端口，；路径，；凭据，；索引，；缓存」这类
  // 65 字 5 段的串，按 80 字会被放过，但它显然不是一个判断。
  if (len > 50 && (t.match(MULTI_CLAUSE) || []).length >= 2) reasons.push('multi-clause(≥3 段)')

  // needs_rewrite：写法上不是「一句可独立成立的判断」
  if (len < 12) reasons.push(`too-short(${len}<12)`)
  if (LIST_HEAD.test(t)) reasons.push('list-marker(列表符号)')
  if (HALF_TAIL.test(t)) reasons.push('half-sentence(半截句结尾)')
  if (ARROW.test(t)) reasons.push('arrow(箭头流程)')
  const tl = TITLE_LIST.exec(t)
  if (tl && !VERB_IN_HEAD.test(tl[1])) reasons.push('title-list(标题后接清单)')
  if (nature === 'body') reasons.push('nature=body')

  // 顺序：粗粒度优先于写法问题——一条又长又是半截句的，先说它太长
  if (reasons.some((r) => r.startsWith('too-long') || r.startsWith('multi-clause') || r.startsWith('nature='))) {
    return { verdict: 'too_coarse', reasons }
  }
  if (reasons.length) return { verdict: 'needs_rewrite', reasons }
  // 长度用汉字数兜底：纯符号/英文的极短串也算没信息量
  if (han === 0 && len < 20) return { verdict: 'needs_rewrite', reasons: [`no-cjk-and-short(${len})`] }
  return { verdict: 'pass', reasons: [] }
}

// ---- 读库（主流程） -------------------------------------------------------

if (IS_MAIN) main()

function main() {
const db = new DatabaseSync(DB, { readOnly: true })
const where = ["a.nature NOT IN ('title','body')", 'a.active = 1']
const params = []
if (ONLY) { where.push("COALESCE(c.status,'') = ?"); params.push(ONLY) } else { where.push("COALESCE(c.status,'') != 'deleted'") }
const rows = db.prepare(`
  SELECT a.id, a.text, a.nature, a.subject, a.fact_key, c.path, c.title, c.status
  FROM atoms a JOIN cards c ON c.id = a.card_id
  WHERE ${where.join(' AND ')}
`).all(...params)
db.close()

// ---- 分类 -----------------------------------------------------------------

const bucket = { pass: [], too_coarse: [], needs_rewrite: [] }
for (const r of rows) {
  const { verdict, reasons } = classifyAtom(r.text, { nature: r.nature })
  bucket[verdict].push({ ...r, reasons })
}

const total = rows.length
const pct = (n) => (total ? (n / total * 100).toFixed(1) : '0.0')

// 按卡片聚合问题集中度：用于判断「该不该整张卡重写」
const badByCard = new Map()
for (const r of [...bucket.too_coarse, ...bucket.needs_rewrite]) {
  const cur = badByCard.get(r.path) || { path: r.path, title: r.title, status: r.status, bad: 0 }
  cur.bad++
  badByCard.set(r.path, cur)
}
const worstCards = [...badByCard.values()].sort((a, b) => b.bad - a.bad).slice(0, 10)

if (JSON_OUT) {
  console.log(JSON.stringify({
    vault: VAULT, only: ONLY, total,
    counts: Object.fromEntries(Object.entries(bucket).map(([k, v]) => [k, v.length])),
    samples: Object.fromEntries(Object.entries(bucket).map(([k, v]) => [k, v.slice(0, SAMPLES).map((x) => ({ text: x.text, path: x.path, reasons: x.reasons }))])),
    worstCards,
  }, null, 2))
  process.exit(bucket.too_coarse.length || bucket.needs_rewrite.length ? 2 : 0)
}

console.log(`库：${VAULT}${ONLY ? `（只审 ${ONLY}）` : ''}`)
console.log(`审计原子：${total} 条（已排除 title / body / 已失效）\n`)
console.log(`pass           ${String(bucket.pass.length).padStart(6)}  ${pct(bucket.pass.length).padStart(5)}%`)
console.log(`needs_rewrite  ${String(bucket.needs_rewrite.length).padStart(6)}  ${pct(bucket.needs_rewrite.length).padStart(5)}%`)
console.log(`too_coarse     ${String(bucket.too_coarse.length).padStart(6)}  ${pct(bucket.too_coarse.length).padStart(5)}%`)

// 原因分布：先看哪种毛病最多，才知道该改提示词还是改写法
const reasonCount = new Map()
for (const r of [...bucket.too_coarse, ...bucket.needs_rewrite]) {
  for (const rs of r.reasons) {
    const key = rs.replace(/\(.*\)/, '')
    reasonCount.set(key, (reasonCount.get(key) || 0) + 1)
  }
}
console.log('\n原因分布（一条原子可命中多条）：')
for (const [k, v] of [...reasonCount.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(22)} ${v}`)
}

for (const [k, label] of [['needs_rewrite', '需要重写'], ['too_coarse', '过粗']]) {
  const items = bucket[k].slice(0, SAMPLES)
  if (!items.length) continue
  console.log(`\n${label}样本（前 ${items.length} 条）：`)
  for (const it of items) {
    console.log(`  · [${it.reasons.join(',')}] ${String(it.text).slice(0, 90)}`)
    console.log(`    ${it.path}  (${it.status})`)
  }
}

if (worstCards.length) {
  console.log('\n问题最集中的卡（前 10）：')
  for (const c of worstCards) console.log(`  ${String(c.bad).padStart(3)} 条  ${c.path}  (${c.status})`)
}

// 退出码：0 全部 pass；2 有问题（便于 CI 或定时任务判断）
process.exit(bucket.too_coarse.length || bucket.needs_rewrite.length ? 2 : 0)
}
