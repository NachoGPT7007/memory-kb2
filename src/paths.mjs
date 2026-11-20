// 路径解析的唯一真源。
//
// 为什么单独一个文件（2026-11-20）：
//   重构到 src/ 之后，「vault 在哪」这件事被四处各自实现，默认值还互不相同：
//     src/index.mjs            MEM_VAULT || ~/.memory-vault
//     src/server.mjs           MEM_VAULT || (DSH_HOME/memory-vault 存在则用它) || ~/.memory-vault
//     vendor/embed/sync-index  MEM_VAULT || <本机 DSH 目录>/memory-vault
//     dsh-memory-kb2 插件       MEM_VAULT / DSH_HOME 的 memory-vault
//   同一台机器上这产生了一个致命组合：sync-index 自己算对了 vault，但调子进程
//   重建索引时没传 MEM_VAULT，子进程于是用了 ~/.memory-vault（空目录），把索引
//   建到了别处；而 sync-index 又把「最后同步时间」写回了真正的 vault。
//   结果：真 vault 的索引永远不更新，但所有人（ensureFresh / memory_stats）都
//   认为它是最新的。索引静默落后，无任何报错。
//
// 本文件把解析顺序固定为一份，其余模块一律 import 它。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 解析顺序（先命中先返回）：
 *  1. MEM_VAULT 环境变量 —— 显式指定，最高优先级（第二个库靠它切换）
 *  2. $DSH_HOME/memory-vault —— DSH 宿主的标准落点
 *  3. ~/.memory-vault —— 历史默认值，作为最后兜底
 *
 * 非 DSH 环境（独立 CLI、定时任务）请显式设 MEM_VAULT：
 * 这时既没有 DSH_HOME，也没有别的方式知道你用哪个库。
 */
export function resolveVault() {
  const env = process.env.MEM_VAULT
  if (env && env.trim()) return path.resolve(env.trim())

  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const candidates = [
    path.join(dshHome, 'memory-vault'),
    path.join(os.homedir(), '.memory-vault'),
  ]
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c } catch { /* 探测失败继续下一个 */ }
  }
  // 都不存在时返回第一个候选，让调用方在创建时报出可读路径
  return candidates[0]
}

/** 索引目录（vault 下的 .index）。 */
export function resolveIndexDir(vault) {
  const env = process.env.MEM_INDEX_DIR
  if (env && env.trim()) return path.resolve(env.trim())
  return path.join(vault || resolveVault(), '.index')
}

/** SQLite 索引文件。MEM_INDEX 可覆盖（旧变量，保留兼容）。 */
export function resolveDbPath(vault) {
  const env = process.env.MEM_INDEX
  if (env && env.trim()) return path.resolve(env.trim())
  return path.join(resolveIndexDir(vault), 'memory.sqlite')
}

/** 最后同步时间戳文件。 */
export function resolveStampPath(vault) {
  return path.join(resolveIndexDir(vault), '.last-sync')
}
