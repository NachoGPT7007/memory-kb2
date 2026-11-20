// 索引新鲜度判定 · 单一真源
//
// 2026-11-21：用「内容签名」替代原来的「卡片 max mtime 与 STAMP 时间戳比较」。
//
// 为什么换（实测依据，scripts/eval-freshness-generations.mjs，6 类场景 × 10 次 = 60 次判定）：
//   旧逻辑「stale = 卡片 max mtime > STAMP 里的 Date.now()」误判 20/60（33.3%），漏判两类：
//     1) 删卡——删卡不会抬高 max mtime，索引少一张卡却判定「最新」（10/10 漏判）
//     2) 文件 mtime 早于 STAMP（复制、解包、时钟回拨）——内容变了但 mtime 更旧，同样漏判（10/10）
//   新逻辑「磁盘签名 ≠ 索引记录的签名」误判 0/60。
//
// 另一个理由：旧逻辑两侧的时钟源不同（文件系统 mtime vs 进程 Date.now()）。
// WSL 与 Windows 双端写同一个 vault 时，两侧时钟差几秒就会让判定永远/永不成立，
// 而这是静默的。新逻辑两侧都取文件系统属性，不掺进程时钟。
//
// 机制来源：Resurface core/dense_index.py 的 generations 思路——判失效要比「状态」，
// 不比「时间」。这里的状态是内容签名，粒度到纳秒，避免同一毫秒内的写入被当成无变化。

import { promises as fs } from 'node:fs'
import path from 'node:path'

/** 签名文件落点：放索引目录，与索引同生共死（索引删了签名也该重算）。 */
export function sigPath(vault) {
  return path.join(vault, '.index', '.content-sig')
}

const SKIP_DIRS = new Set(['.git', '.index', 'node_modules'])

/**
 * 算 vault 的内容签名。
 * @returns {Promise<{count:number, maxMtimeNs:string, totalBytes:number}>}
 *   maxMtimeNs 用字符串存：纳秒级 bigint 直接 JSON 化会丢精度并抛 TypeError。
 */
export async function contentSignature(vault, dir = vault, acc = { count: 0, maxMtimeNs: 0n, totalBytes: 0 }) {
  let entries
  try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return acc }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) await contentSignature(vault, p, acc)
    } else if (e.name.endsWith('.md')) {
      try {
        const st = await fs.stat(p, { bigint: true })
        acc.count += 1
        acc.totalBytes += Number(st.size)
        if (st.mtimeNs > acc.maxMtimeNs) acc.maxMtimeNs = st.mtimeNs
      } catch { /* 读不到就当不存在，与 walk 的容错一致 */ }
    }
  }
  acc.maxMtimeNs = String(acc.maxMtimeNs)
  return acc
}

/** 两份签名是否相同。字符串化比较，避免 bigint 结构差异。 */
export function sigEquals(a, b) {
  if (!a || !b) return false
  return String(a.maxMtimeNs) === String(b.maxMtimeNs) &&
    Number(a.count) === Number(b.count) &&
    Number(a.totalBytes) === Number(b.totalBytes)
}

/** 读上次 sync 记下的签名；不存在/坏文件 → null（老索引或首次运行）。 */
export async function readSig(vault) {
  try {
    const raw = await fs.readFile(sigPath(vault), 'utf8')
    const v = JSON.parse(raw)
    if (!v || typeof v !== 'object') return null
    if (v.count === undefined || v.maxMtimeNs === undefined || v.totalBytes === undefined) return null
    return v
  } catch {
    return null
  }
}

/** 记下「索引已覆盖到此状态」。原子写，避免检索侧读到半行。 */
export async function writeSig(vault, sig) {
  const file = sigPath(vault)
  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    await fs.writeFile(tmp, JSON.stringify(sig), 'utf8')
    await fs.rename(tmp, file)
    return true
  } catch {
    return false
  }
}
