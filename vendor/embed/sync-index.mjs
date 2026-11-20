// 增量同步：vault 新增/修改的卡 → SQLite 索引重建 + 只编码新增原子的向量
//
// 为什么 SQLite 全量重建而向量增量：
//   索引重建只要 2–3 秒（4379 条），写增量 diff 的代码复杂度和风险都更高；
//   向量编码才是贵的（模型加载 + 每条 5ms），所以只补缺失的部分。
//
// 用法：
//   node sync-index.mjs           # 同步一次
//   node sync-index.mjs --check   # 只看差多少，不动
import { DatabaseSync } from 'node:sqlite'
import { promises as fs, readFileSync, existsSync as fsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'


const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const VAULT = process.env.MEM_VAULT || path.join(os.homedir(), '.dsh-web-lab', 'memory-vault')
const IDX = path.join(VAULT, '.index')
const DB = path.join(IDX, 'memory.sqlite')
const VF = path.join(IDX, 'vectors.f32')
const VJ = path.join(IDX, 'vectors.json')
// 向量化走阿里云百炼 API（2026-11-04 起本地 ONNX 下线）；模型名变化会触发全量重编码
// 唯一真源：EMBED_API_MODEL（embed-api 读的就是它）。EMBED_MODEL 仅作旧变量兼容。
const MODEL = process.env.EMBED_API_MODEL || process.env.EMBED_MODEL || 'qwen3.7-text-embedding'
process.env.EMBED_API_MODEL = MODEL
const CHECK = process.argv.includes('--check')

// 0) 快速短路：vault 里的 md 自上次同步以来没有变化，直接退出
const STAMP = path.join(IDX, '.last-sync')
let lastMs = 0
try { lastMs = Number(readFileSync(STAMP, 'utf8')) || 0 } catch {}
if (lastMs && !process.argv.includes('--force')) {
  let newest = 0
  async function scan(dir) {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { if (!['.git', '.index', 'node_modules'].includes(e.name)) await scan(p) }
      else if (e.name.endsWith('.md')) { const st = await fs.stat(p); if (st.mtimeMs > newest) newest = st.mtimeMs }
    }
  }
  await scan(VAULT)
  if (newest <= lastMs) {
    // 2026-11-20 修：原来只看卡片 mtime，导致「卡没变但向量缺了」时永远跳过，
    // 新沉淀的卡会一直没向量（实测漏了 25 个原子）。短路条件必须同时确认向量齐。
    let vectorGap = 0
    try {
      const nAtoms = new DatabaseSync(DB, { readOnly: true }).prepare('SELECT COUNT(*) c FROM atoms').get().c
      const meta = JSON.parse(readFileSync(VJ, 'utf8'))
      vectorGap = Math.max(0, nAtoms - (meta.count || 0))
    } catch { vectorGap = -1 }
    if (vectorGap === 0) { console.log(`[0/3] 无变化且向量齐全（最后修改 ${new Date(newest).toISOString().slice(0, 16)}），跳过`); process.exit(0) }
    if (vectorGap > 0) console.log(`[0/3] 卡片未变，但缺 ${vectorGap} 条向量，继续补编码`)
    else console.log('[0/3] 无法确认向量状态，继续全量检查')
  }
}

// 0.5) 补抽原子 —— 自动沉淀写的是 v1 卡（没有 atoms），不补的话新卡只有标题能搜到。
//      迁移脚本是幂等的（已有 v2 的卡跳过），所以每次跑都安全。
try {
  // 可选迁移脚本（v1 → v2 补抽原子）。本机不存在时跳过，不影响同步。
  const MIG = process.env.MEM_MIGRATE_SCRIPT || path.join(ROOT, 'scripts', 'memory-migrate-v2.mjs')
  if (!fsSync.existsSync(MIG)) throw new Error('no migrate script')
  const mo = execFileSync('node', [MIG, '--apply'], { encoding: 'utf8' })
  const added = mo.match(/新增原子 (\d+) 条/)?.[1] || '0'
  const migrated = mo.match(/迁移 (\d+)/)?.[1] || '0'
  if (added !== '0') console.log(`[0.5/3] 补抽原子：${migrated} 张卡，${added} 条原子`)
  else console.log('[0.5/3] 无需补抽（没有缺原子的新卡）')
} catch (e) {
  console.log('[0.5/3] 补抽失败，跳过：' + String(e?.message || '').slice(0, 80))
}

// 1) 重建 SQLite（调 memory-index 的 build）
// --check 只报告差异，不得改数据（2026-11-20 修：原实现 --check 仍会重建索引）
let out = ''
if (CHECK) {
  console.log('[1/3] （--check：跳过重建）')
} else {
  console.log('[1/3] 重建 SQLite 索引 …')
  out = execFileSync('node', [path.join(ROOT, 'scripts', 'memory-index.mjs'), '--build'], { encoding: 'utf8' })
  console.log('  ' + out.trim().split('\n')[0])
}

// 2) 找出没有向量的原子
const db = new DatabaseSync(DB, { readOnly: true })
const all = db.prepare('SELECT id, text FROM atoms').all()
db.close()

let meta = null
try { meta = JSON.parse(readFileSync(VJ, 'utf8')) } catch {}
if (meta && meta.model !== MODEL) {
  console.log(`  模型变了（${meta.model} → ${MODEL}），全量重编码`)
  meta = null
}
let have = new Set(meta?.ids || [])
let missing = all.filter((a) => !have.has(a.id))
// 超过一半原子没有向量（多为重抽导致 ID 全变）→ 视为全量重建，丢弃旧向量
if (meta && missing.length > all.length * 0.5) {
  console.log(`  ${missing.length}/${all.length} 缺少向量，判定为重抽后的全量重建`)
  meta = null
  have = new Set()
  missing = all
}
console.log(`[2/3] 原子 ${all.length}，已有向量 ${have.size}，待编码 ${missing.length}`)

if (CHECK || !missing.length) {
  console.log(CHECK ? '（--check：未改动）' : '无需编码，索引已最新')
  if (!CHECK) await fs.writeFile(STAMP, String(Date.now()))
  process.exit(0)
}

// 3) 只编码缺失部分，追加到向量文件
console.log(`[3/3] 调 API 编码（${MODEL}）…`)
const { embed } = await import('../../src/embed-api.mjs')
const BATCH = 10   // 百炼同步接口单次上限 10 行
const newIds = []
const chunks = []
const tEnc = Date.now()
for (let i = 0; i < missing.length; i += BATCH) {
  const batch = missing.slice(i, i + BATCH)
  const list = await embed(batch.map((r) => r.text))
  for (let j = 0; j < batch.length; j++) {
    newIds.push(batch[j].id)
    chunks.push(Buffer.from(new Float32Array(list[j]).buffer))
  }
  if (i === 0 || (i / BATCH) % 20 === 0) {
    const per = (Date.now() - tEnc) / Math.max(newIds.length, 1)
    const eta = Math.round(per * (missing.length - newIds.length) / 1000)
    console.log(`  ${newIds.length}/${missing.length} … 剩余约 ${eta}s`)
  }
}

// 旧向量 + 新向量，一次写出
// 注意：模型变化时 meta 已被置空，此时绝不能读旧文件——否则新旧模型向量会拼在一起，
// 而 vectors.json 只记新 ids，读取端按偏移取向量就会全量错位（2026-11-04 踩过）。
let oldBuf = Buffer.alloc(0)
if (meta) { try { oldBuf = await fs.readFile(VF) } catch {} }
const newBuf = Buffer.concat(chunks)
const total = Buffer.concat([oldBuf, newBuf])
const dim = (newBuf.length / newIds.length) / 4
await fs.writeFile(VF, total)
await fs.writeFile(VJ, JSON.stringify({
  model: MODEL,
  dim,
  count: (meta?.count || 0) + newIds.length,
  ids: [...(meta?.ids || []), ...newIds],
  builtAt: new Date().toISOString(),
}))
console.log(`  完成：新增 ${newIds.length} 条向量，总计 ${(total.length / 1048576).toFixed(1)} MB`)
await fs.writeFile(STAMP, String(Date.now()))
