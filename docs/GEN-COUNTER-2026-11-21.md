# 世代计数器（第二批第一项）· 2026-11-21

> 对应 NEXT-SESSION-2026-11-21.md §4 第二批第 4 项「世代计数器 —— 替代 STAMP 时间戳 + 60 秒缓存」。
> 机制来源：Resurface `core/dense_index.py` 的三级 `(epoch, space, vectors)` 只增计数器。

## 0. 结论

把「索引是否落后」的判定依据从**时间**换成**状态签名**。60 次判定里旧逻辑误判 **20 次（33.3%）**，
新逻辑 **0 次**。改动集中在新增的 `src/freshness.mjs`，`build`/`sync` 与 `ensureFresh` 各接一处。

## 1. 为什么不是照搬「写时 bump 的计数器」

Resurface 的计数器成立的前提是：**所有写入都经过它自己**——写卡时同事务 `+1`，读取侧比计数器就知道有没有新数据。

kb2 没有这个前提。vault 是 Markdown 真源，任何通道都能改：

| 写通道 | 是否经过 kb2 |
|---|---|
| 插件自动沉淀（capture） | 否，直接写文件 |
| `memory_update` | 是（MCP 工具） |
| 手工编辑器 / 其他 agent / 脚本 | 否 |
| 双端（WSL + Windows）写同一目录 | 否 |

所以纯计数器在 kb2 上会漏掉「外部写入」这一大类，反而比现状更不可靠。

**退一步的做法**：计数器记的不是「写了几次」，而是「索引覆盖到的内容状态」——
内容签名 `{count, maxMtimeNs, totalBytes}`。两侧都从文件系统取，不掺进程时钟。

这仍然保留了 Resurface 的核心判断：**比状态，不比时间**。

## 2. 旧逻辑的两个实测缺陷

旧判定：`stale = 卡片 max mtime > STAMP 文件里的 Date.now()`（`src/server.mjs` 原 `ensureFresh`）。

| 场景 | 旧逻辑 | 签名逻辑 |
|---|---|---|
| 无变化 | 0.00 ✓ | 0.00 ✓ |
| 新增卡 | 1.00 ✓ | 1.00 ✓ |
| 修改卡 | 1.00 ✓ | 1.00 ✓ |
| **删卡** | **0.00 ✗ 漏判** | 1.00 ✓ |
| **mtime 早于 STAMP**（复制/解包/时钟回拨） | **0.00 ✗ 漏判** | 1.00 ✓ |
| mtime 在未来 | 1.00 ✓ | 1.00 ✓ |

**误判合计：旧 20/60（33.3%），新 0/60。**

两条漏判的机理：
1. **删卡不抬高 max mtime**——索引少一张卡，判定仍说「最新」，那张卡在被删之前的内容会一直从索引里被检索到（真源已不存在）。
2. **两侧时钟源不同**——文件系统 mtime vs 进程 `Date.now()`。双端写同一 vault 时，Windows 侧时钟快几秒就能让「永远落后 / 永不落后」二选一，且静默。

## 3. 改了什么

### 3.1 新增 `src/freshness.mjs`（单一真源）

| 函数 | 作用 |
|---|---|
| `contentSignature(vault)` | 递归算 `{count, maxMtimeNs, totalBytes}`，纳秒精度 |
| `sigEquals(a, b)` | 三项逐项比 |
| `readSig` / `writeSig` | 读写 `.index/.content-sig`，原子写 |

纳秒不是洁癖：毫秒精度下「同一毫秒内写入」会让签名完全相同。实测第一版评测用毫秒，`add-card` 漏判 2/10、`modify-card` 漏判 4/10——那是评测循环太快造成的假象。改用 `stat(p, {bigint:true}).mtimeNs` 后消失。**这条记在这里，是因为下次改评测脚本时还会踩。**

### 3.2 `src/index.mjs`

- `build()` 结尾写签名
- `sync()` 结尾：**有增删改**才重算签名，无变化沿用旧签名（省一次全库遍历）
- `sync()` 无变化早退分支：若还没有签名（老索引）则补写——**否则检索侧永远判 stale，每 60 秒白拉一次 sync**

第三个位置是实测踩出来的：第一次改完生产库跑 sync，签名文件没生成，因为无变化时函数在 `!toAdd.length && !toDelete.length` 就 return 了。

### 3.3 `src/server.mjs`

`ensureFresh()` 改为：

```
读 .content-sig 小文件（与原来读 STAMP 同价）
60 秒窗口内且签名未变 → 返回缓存结果
否则算磁盘签名 → stale = 签名不相等
```

`lagMs` 改为「磁盘最新 mtime − 索引记录 mtime」（只用于给用户看落后多久）。
顺手删掉了已无调用者的 `newestMtime()`——留着会让人以为还有地方在用它。

`STAMP`（`.last-sync`）**保留不动**：`vendor/embed/sync-index.mjs` 还在读它决定哪些卡要重新向量化，那是另一回事。

## 4. 验证

| 脚本 | 结果 | 覆盖 |
|---|---|---|
| `scripts/eval-freshness-generations.mjs` | 旧 20/60 误判 → 新 0/60 | 6 类场景 × 10 次，用生产 `freshness.mjs` 而非复刻 |
| `scripts/verify-gen-counter.mjs` | 14/14 | build 生成签名、无变化不变、加/删卡后签名同步、无签名判 stale 并补写 |
| `scripts/smoke.mjs` | 16/16 | 不回归 |

生产库接线：手动 `sync()` 后 `.content-sig` = `{count:528, maxMtimeNs:…, totalBytes:4787311}`，与磁盘实时算的一致。

## 5. 回滚

```bash
cd ~/memory-kb2
git revert <本次 commit>
systemctl --user restart dsh-lab-web
# 或只删签名文件回到「无签名」状态：rm vault/.index/.content-sig（不影响索引本身）
```

## 6. 未做

- Resurface 的「构建后复读计数器，不一致即 `builds_not_kept`」——当前单进程写索引，暂不适用；双端同时 sync 时才需要
- `space` / `vectors` 两级校验：向量侧目前靠 `vectors.json` 里的 `model` 字段，读取时未强校验；留到第二批其余项之后
