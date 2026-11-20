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
import { promises as fs, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolveVault, resolveIndexDir, resolveDbPath, resolveStampPath } from '../../src/paths.mjs'
import { EMBED_MODEL } from '../../src/constants.mjs'


const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
// 2026-11-20 重构：路径不再本地推算，统一走 src/paths.mjs。
// 历史坑：本文件原来自己算 VAULT，且默认值与 src/index.mjs 不同，与
// src/index.mjs 的默认 ~/.memory-vault 不一致；而重建索引是调子进程做的，
// 又没把 MEM_VAULT 传下去，于是索引建到了空库、时间戳却写回了真 vault。
const VAULT = resolveVault()
const IDX = resolveIndexDir(VAULT)
const DB = resolveDbPath(VAULT)
const VF = path.join(IDX, 'vectors.f32')
const VJ = path.join(IDX, 'vectors.json')
// 向量化走阿里云百炼 API（2026-11-04 起本地 ONNX 下线）；模型名变化会触发全量重编码
// 唯一真源：EMBED_API_MODEL（embed-api 读的就是它）。EMBED_MODEL 仅作旧变量兼容。
const MODEL = EMBED_MODEL   // 唯一真源：src/constants.mjs
process.env.EMBED_API_MODEL = MODEL
const CHECK = process.argv.includes('--check')

// 0) 快速短路：vault 里的 md 自上次同步以来没有变化，直接退出
const STAMP = resolveStampPath(VAULT)
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
//      2026-11-20：迁移脚本当前不存在，且此处曾有一个把函数当对象用的 bug
//      （existsSync as fsSync 后又写 fsSync.existsSync），两者都被 catch 吞成
//      「补抽失败，跳过」。现在按「缺脚本」与「执行失败」两种情况分别报出，
//      并统计有多少张卡因此没有原子——不再静默。
{
  const MIG = process.env.MEM_MIGRATE_SCRIPT || path.join(ROOT, 'scripts', 'memory-migrate-v2.mjs')
  if (!existsSync(MIG)) {
    console.log(`[0.5/3] 跳过补抽：迁移脚本不存在 ${MIG}`)
  } else {
    try {
      const mo = execFileSync('node', [MIG, '--apply'], { encoding: 'utf8', env: { ...process.env, MEM_VAULT: VAULT } })
      const added = mo.match(/新增原子 (\d+) 条/)?.[1] || '0'
      const migrated = mo.match(/迁移 (\d+)/)?.[1] || '0'
      if (added !== '0') console.log(`[0.5/3] 补抽原子：${migrated} 张卡，${added} 条原子`)
      else console.log('[0.5/3] 无需补抽（没有缺原子的新卡）')
    } catch (e) {
      console.log('[0.5/3] 补抽失败（不影响本次重建）：' + String(e?.message || '').slice(0, 160))
    }
  }
}

// 1) 同步 SQLite 索引
// 2026-11-20 重构：默认走增量 sync（只处理新增/修改/删除的卡），
// 不再每次 fs.rm 删库重建。实测 508 卡时：全量约 1000ms，增量约 50ms。
// 需要强制全量时用 --full 或 --force。
// --check 只报告差异，不得改数据。
const FULL = process.argv.includes('--full')
let out = ''
if (CHECK) {
  console.log('[1/3] （--check：跳过同步）')
} else {
  // 同进程内调用，不再 fork 子进程——避免「子进程用不同默认路径」那类错配。
  // 路径真源已经是同一个 src/paths.mjs。
  const idx = await import(path.join(ROOT, 'src', 'index.mjs'))
  // 注意：--force 只用于「跳过第 0 步的快速短路」，不传给 sync()。
  // 传给 sync() 会让每张卡都删了重建（实测 508 卡 8810ms，比全量还慢）。
  // 真正要全量重建时用 --full。
  const r = FULL ? await idx.build() : await idx.sync()
  const mode = FULL ? '全量重建' : (r.fullBuild ? '首次全量' : '增量')
  console.log(`[1/3] ${mode}：卡 ${r.nCards ?? r.nCards} / 原子 ${r.nAtoms} / 倒排 ${r.nPost}（${(r.ms ?? 0)} ms）`)
  out = ''
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

// 没有缺失向量时也要看一眼「陈旧向量」：原子被删/重抽后，旧向量仍躺在
// vectors.f32 里，只增不减（实测 884 条 / 14%）。有陈旧就走下面的回收写出。
const liveIdSet = new Set(all.map((a) => a.id))
const staleCount = meta?.ids?.length ? meta.ids.reduce((n, id) => (liveIdSet.has(id) ? n : n + 1), 0) : 0
if (!CHECK && staleCount > 0) {
  console.log(`  发现 ${staleCount} 条陈旧向量，执行回收`)
}
if (CHECK || (!missing.length && !staleCount)) {
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
  // 索引构建是批量、非交互、可重试的路径：显式放宽超时，不跟随查询侧的 5s 默认值
  //（一批 10 条，实测通常 200–400ms；网络抖动时留足余量，宁可重试也不要把整库建半截）。
  const list = await embed(batch.map((r) => r.text), { timeoutMs: 30_000, retries: 1 })
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
//
// 2026-11-20：写出前先回收陈旧向量。原子被重抽/删除后，旧向量仍留在 vectors.f32 里
// （实测 5276 原子 / 6160 向量 = 884 条陈旧，占 14%），文件只增不减。
// 这里按当前索引的 atom id 过滤，把「不再对应的向量」丢掉。
const liveIds = new Set(all.map((r) => r.id))
let keptIds = []
let keptChunks = []
let reclaimed = 0
if (meta && Array.isArray(meta.ids) && meta.ids.length) {
  let oldBuf = Buffer.alloc(0)
  try { oldBuf = await fs.readFile(VF) } catch { oldBuf = Buffer.alloc(0) }
  const oldDim = meta.dim || 0
  const stride = oldDim * 4
  if (stride > 0 && oldBuf.length >= meta.ids.length * stride) {
    for (let i = 0; i < meta.ids.length; i++) {
      const id = meta.ids[i]
      if (liveIds.has(id)) {
        keptIds.push(id)
        keptChunks.push(oldBuf.subarray(i * stride, (i + 1) * stride))
      } else reclaimed++
    }
  } else if (oldBuf.length) {
    console.log(`  ⚠ 旧向量文件长度异常（${oldBuf.length}B / ids ${meta.ids.length} / dim ${oldDim}），放弃沿用，全量重编码`)
    keptIds = []
    keptChunks = []
  }
}
const newBuf = Buffer.concat(chunks)
const total = Buffer.concat([...keptChunks, newBuf])
const dim = newIds.length ? (newBuf.length / newIds.length) / 4 : (meta?.dim || 1024)
await fs.writeFile(VF, total)
await fs.writeFile(VJ, JSON.stringify({
  model: MODEL,
  dim,
  count: keptIds.length + newIds.length,
  ids: [...keptIds, ...newIds],
  builtAt: new Date().toISOString(),
}))
if (reclaimed) console.log(`  回收陈旧向量 ${reclaimed} 条`)
console.log(`  完成：新增 ${newIds.length} 条向量，总计 ${(total.length / 1048576).toFixed(1)} MB / ${keptIds.length + newIds.length} 条`)
await fs.writeFile(STAMP, String(Date.now()))
