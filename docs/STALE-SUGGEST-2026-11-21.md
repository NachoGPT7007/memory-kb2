# 陈旧卡改为只读建议（第二批第三项）· 2026-11-21

> 对应 NEXT-SESSION-2026-11-21.md §4 第二批第 6 项「只读建议 —— staleDays 自动删改成建议」。
> 机制来源：LMC-5 `metabolism.py:78` 的 `patrol()`——纯 SELECT，返回分级建议，一行不改。

## 0. 先量规模：当前触发为 0

改之前先看真实库里有多少卡符合条件：

| 项 | 实测 |
|---|---|
| 总卡数（含各状态） | 480 |
| mtime 超过 90 天 | **0** |
| 最旧三张 | 2026-11-08（`00-System/daily-*`） |

库本身建得晚（最早 mtime 11-08），所以「90 天没动就删」这条路径**当前一次都不会触发**。
这个改动的价值是预防性的，无法用真实数据验证效果——只能验证「逻辑上不再删除」。

## 1. 顺带发现：`staleDays` 是死参数

```js
// 改前 optimizeApply
const staleDays = Number(opts.staleDays ?? 90)   // 读了
const cands = await optimizeCandidates(root)     // 没传下去
// optimizeCandidates 内部
const old = Date.now() - 90 * 86400000           // 硬编码 90
```

调用方无论传什么 `staleDays`，实际都按 90 天算。已修：`optimizeCandidates(root, { staleDays })`。

## 2. 改了什么

### 2.1 `lib/vault.js`

| 改前 | 改后 |
|---|---|
| `cleanupStale=true` → 逐张 `deleteCard`（软删） | 任何参数都不删除，只返回建议 |
| 返回 `staleDeleted` / `staleSkipped` | 返回 `staleSuggestions`（带 `ageDays`）、`staleTotal`、`staleTruncated`、`staleAction: 'suggest-only'` |
| `stale` 硬编码 90 天 | 接受 `staleDays` |
| `stale` 静默截断 30 条 | 保留 30 条上限，但返回 `staleTotal` 与 `staleTruncated` 说明还有多少没列出 |

### 2.2 `web/app.js`

`/optimize-execute` 的返回字段变了，前端两处同步：

- 文案：中文「张陈旧卡已清理」→「张陈旧卡已列为建议（未删除）」；英文 `stale cards cleaned` → `stale cards flagged (not deleted)`
- 字段：`X.plan.staleDeleted` → `X.plan.staleSuggested`

备份：`web/app.js.bak-*-pre-stale-suggest`

## 3. 保留的删除入口

「复核/回收站」页有一个独立的**「清理陈旧卡」按钮**，逐张调 `/delete?path=`。这个**没有改**：

- 它是人工点击 + `window.confirm` 的显式决策，属于「人裁决」，与「系统自动删」是两件事
- 但要提醒：它一次最多处理 30 张（`stale` 的 `slice(0, 30)`），列表外的陈旧卡不会被列出

## 4. 验证

`scripts/verify-stale-suggest-only.mjs` → **11/11**：

- 传 `cleanupStale: true` 后，卡片文件仍在磁盘、没有一张变成 `status: deleted`
- 返回值是 `staleAction: 'suggest-only'`，且不再含 `staleDeleted` 字段
- `staleDays` 生效：30 天识别 2 张、200 天识别 0 张
- 建议项带 `ageDays`（实测 120）

回归：`verify-fact-key.mjs` 12/12、`verify-t3-origin-skiplog.mjs` 22/22 均通过。

## 5. 另一个数字：`/optimize` 很慢

`optimizeCandidates` 在真实库（480 卡）上耗时 **12.6 秒**——它对所有同 kind 卡两两算 `textSimilarity`，
480 卡约 5.7 万对。这不是本轮的改动范围，但每次点「扫描并整理」都要等 12.6 秒，值得单独处理
（按 kind 分桶 + 先按标题粗筛可以砍掉大部分配对）。

## 6. 回滚

```bash
cd ~/dsh-armory
git revert <commit>
cp packages/dsh-memory-kb2/web/app.js.bak-*-pre-stale-suggest packages/dsh-memory-kb2/web/app.js
systemctl --user restart dsh-lab-web
```

## 7. 未做

- 陈旧卡的分级（LMC-5 的 critical / warning）：当前只有单一 90 天阈值，没有分级
- 「最近被检索过」这一信号没有参与陈旧判定：一张 90 天没改但每周被命中的卡，显然不该算陈旧
