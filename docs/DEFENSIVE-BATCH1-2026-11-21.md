# 第一批防御性改动 · 2026-11-21

> 对应 [NEXT-SESSION-2026-11-21.md](./NEXT-SESSION-2026-11-21.md) §4「第一批：防御性（不改检索行为，风险低）」。
> 本文只记「改了什么、怎么验的、怎么回滚」。实验纪律见 [HANDOFF.md](./HANDOFF.md) §1。

## 0. 一句话状态

三项全部落地，各自独立验证通过（#1 14/14、#2 8/8、#3 22/22），既有 smoke 16/16 不回归。
**已于 2026-11-21 01:51:11 重启 `dsh-lab-web` 生效，三件事线上验证通过（见 §5.1）。**

---

## 1. 前置阻塞：ALI_API_KEY 不可达（不在原待办清单里）

### 现象

`memory_stats` 报 `检索模式：bm25-only: 缺少 ALI_API_KEY`。查询向量、RRF 融合、重排三件事全部没在工作，检索实际是纯 BM25 单路。

### 证据（两条独立来源）

| 证据 | 内容 |
|---|---|
| 凭据存在 | `$DSH_HOME/.credentials.yaml` 的 `refs` 段有 `ALI_API_KEY` |
| 子进程拿不到 | MCP 子进程 env 只有 38 条，无 `DSH_HOME`、无 `ALI_API_KEY`；父进程 389089 有 `DSH_HOME` |
| 复刻验证 | `env -u DSH_HOME` → `hasKey=false, no-key`；加 `DSH_HOME` → `hasKey=true` |
| 代码路径 | `src/embed-api.mjs:20` 靠 `DSH_HOME` 找 `$DSH_HOME/.credentials.yaml`，找不到回退到不存在的 `~/.dsh/.credentials.yaml` |

### 原因

`$DSH_HOME/profiles/web/cordis.patch.yml` 的 `mcp-memory-kb2` 只给子进程传了 `MEM_VAULT` 和 `MEM_ALIAS`。MCP 子进程的 env 是白名单（不继承父进程），所以 `DSH_HOME` 缺失。

### 修法

同文件 env 段加一行 `DSH_HOME: <本机 DSH_HOME>`。

- 回滚：删该行 + `systemctl --user restart dsh-lab-web`
- 备份：`cordis.patch.yml.bak-<时间戳>-pre-dshhome`
- 未动 `mcp-memory-kb2-wiki`（用户选择只修主库）

### 影响

改之前 #2 无法验证——向量压根不被调用，改 30s 还是 5s 都测不出差别。

---

## 2. #3 拒绝留痕 + 来源溯源

改在插件仓库 `~/dsh-armory/packages/dsh-memory-kb2`（不是 `~/memory-kb2`）。

### 2.1 拒绝留痕

新增 `lib/skiplog.js`：每次「没写成卡」追加一行 JSONL 到 `$DSH_HOME/.state/memory-kb2-skips.jsonl`，超 512KB 轮转成 `.1`（只留一代）。

接入点：

| 原因 | 位置 |
|---|---|
| `config-gate` / `daily-quota` / `no-route` / `no-new-events` / `idle-empty-pending` | `index.js` 的前置闸门 |
| `too-short` / `llm-no-result` / `not-durable` / `write-failed` / `card-not-written` | `lib/capture.js` 的判定链 |
| `summarize/<内层原因>` | `summarizeTurn` 的预筛（带阶段前缀，与外层区分） |

**踩到的坑**：`onSkip` 是异步落盘，而 skip 分支是同步 `return`。直接 fire-and-forget 会让「返回 stat 后立刻读文件」读到空（实测竞态）。改为收集 promise，在各出口 `flushSkips()` 统一 await。

### 2.2 来源溯源

卡片 frontmatter 新增 `origin` 字段：

```
origin: session=<会话id> seq=<起>-<止> agent=deepseek-harness
```

`seq` 与 `.state/memory-kb2-lastseq.json` 同一套编号，可直接回查会话事件。

### 2.3 顺带修的既有缺陷（同一变量：frontmatter 重写保真）

`parseCard` 原先只提取白名单键，而 `setCardStatus` / `appendUpdate` / `deleteCard` / `restoreCard` 这些「整卡重写」路径只重建白名单字段——**多行 `atoms` 块会在一次审核操作后整块消失**。

修法：`parseCard` 把不认识的 frontmatter 行存进 `meta.extraLines`，新增 `renderFrontmatter(fields, meta)` 在写回时原样放回。5 处拼装全部改用它。

**历史损坏排查**：真实库 526 卡 / 469 张含 `atoms` 块；6 张有「更新记录」段（即曾被 `appendUpdate` 重写）的卡**全部**也没有 `atoms` 块——但无证据表明它们写入时就带过 atoms。结论：**未发现历史损坏证据，但也不能排除**（无从回溯）。

### 2.4 验证

`node scripts/verify-t3-origin-skiplog.mjs` → **22/22 通过**。覆盖：新卡写入 → `setCardStatus` → `appendUpdate` → `deleteCard` → `restoreCard` 全链路后 `origin` 与 `atoms` 仍在；四类 skip 分支均落盘且字段完整。

---

## 3. #1 写入设置校验

改在 `~/memory-kb2/src/index.mjs`。

### 设计

机制来自 Resurface `core/write_settings.py`。kb2 的「写入设置」= 决定倒排索引与向量能否互相比对的四个变量：

```js
{ schema: 'cards/atoms/postings/v1', tokenizer, embedModel, embedDim, formatVersion: 2 }
```

- `build()` 时写进 `meta.write_settings`（JSON）
- `sync()` 开头比对，不一致 → 明确报差异 + 全量重建，返回 `rebuiltReason`
- 老库无登记 → 以当前代码设置为准回填一次，**不重建**，日志注明「历史设置无法回溯」

### 为什么不能只靠「缺列就重建」

改 `MEM_TOKENIZER` 后 `cards` 表一列不缺，但 `postings` 的 token 语义已经全变。旧代码会安静地继续用这份索引检索，命中率掉多少没人知道。

### 验证

`node scripts/verify-t1-writesettings.mjs` → **14/14 通过**（子进程跑，因为 tokenizer 是模块加载时读取的常量）。覆盖：登记内容正确、一致时走增量、tokenizer 变更触发重建且 `rebuiltReason` 写明 `tokenizer: regex → ws`、老库回填不重建。

---

## 4. #2 查询向量超时 30s → 5s

改在 `~/memory-kb2/src/embed-api.mjs`。

| 函数 | 改前 | 改后 |
|---|---|---|
| `post()` 兜底默认 | 30_000 | 5_000 |
| `embed()` 默认 | 30_000 | 5_000，重试 1 → 0 |
| `rerank()` 默认 | 30_000 | 5_000，重试 1 → 0 |
| `vendor/embed/sync-index.mjs` 批量编码 | 跟随默认 | 显式 `timeoutMs: 30_000, retries: 1` |

**关闭查询重试的理由**：5s + 默认 1 次重试 = 最坏 10s，超出「查询预算」原意。Resurface `core/recall.py` 的三层预算（查询向量 3s、补算 2s）指向的是总预算而非单次。

**索引路径不放宽的理由**：批量、非交互、可重试；不能因为一次网络抖动把整库建半截。

### 验证（`scripts/verify-t2-timeout.mjs` → 8/8）

| 项 | 实测 |
|---|---|
| embedding 往返 10 次 | p50 **163ms**、max **285ms**，5s 余量 **17.5×** |
| rerank 一次 | 218ms（第二次 128ms） |
| 超时参数生效 | 传 1ms → 16ms 内 abort |
| 既有 smoke | 16/16 不回归 |

---

## 5. 生效与回滚

```bash
# 生效（会中断本会话进程，页面需刷新）
systemctl --user restart dsh-lab-web

# 回滚
#   配置：删除 cordis.patch.yml 里 mcp-memory-kb2 env 的 DSH_HOME 行
#   代码：git checkout -- src/ vendor/            （在 ~/memory-kb2）
#         git checkout -- index.js lib/           （在 ~/dsh-armory/packages/dsh-memory-kb2）
#   备份：cordis.patch.yml.bak-20261121-014707-pre-dshhome
#         ~/dsh-armory/packages/dsh-memory-kb2/backup/
```

### 5.1 重启后线上验证（2026-11-21 01:51–01:57）

| # | 判据 | 实测 |
|---|---|---|
| 1 | `memory_stats` 不再 `bm25-only` | `检索模式：hybrid(api)`，向量化/重排均走 API |
| 2 | 检索 `mode` 含向量融合 | `模式：hybrid(rrf,semantic)`，428ms |
| 3 | 新沉淀卡带 `origin` | `origin: session=<会话 id> seq=8-613 agent=deepseek-harness`（2 张卡各 8 / 5 条原子） |
| 附加 | #1 在生产库的写入设置 | 手动触发一次 `sync()`：`skipped=526`，77ms，无重建；`meta.write_settings` 写入成功，日志「历史设置无法回溯」 |

重启代价：重启前有一个 capture 已 armed（84 个新事件），内存里的 pending 随进程消失。
既有设计如此（lastSeq 只在提炼完成才推进），不是本次改动引入的。

---

## 6. 未做与待办

- **已提交，未 push**：
  - `~/memory-kb2`：`1344df7`（上一轮召回判断链 + 别名表 v2）、`97b94f3`（本批三项）
  - `~/dsh-armory`：`661787f`（拒绝留痕 + 溯源 + frontmatter 保真，含上轮判定链合并）
- 第二批（世代计数器 / fact_key 槽位替换 / 只读建议）未动
- `scripts/selfcheck.mjs` 的 usage 字符串写的是 `kb2-selfcheck.mjs`（文件名旧名），照抄会报 `MODULE_NOT_FOUND`——既有小坑，不影响功能
