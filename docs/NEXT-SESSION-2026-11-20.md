# 新会话交接（2026-11-20 凌晨）

> 本文只写「新会话必须知道的事实 + 立刻要做的事」。实验细节见
> [`EXPERIMENT-2026-11-20.md`](./EXPERIMENT-2026-11-20.md)，机制见 [`MECHANISM.md`](./MECHANISM.md)。

## 0. 一句话状态

**仓库 HEAD `85c5687`，8 个提交已落地；DSH 生产已切到仓库版但还没重启验证；npm 包未发布（等账号登录）。**

## 1. 立刻要做的三件（按顺序）

### ① 重启 dsh web，验证新版上线

生产 MCP 已从 `~/dsh-armory/mcp/memory-server.mjs`（11-14 旧版 548 行）切到
`~/memory-kb2/src/server.mjs`（675 行），但**上次重启时撞上 vault 路径 bug**，
已在 `038ef0c` 修复：

- 旧版把 vault 硬编码成 `/home/nachogpt/.dsh-web-lab/memory-vault`
- 仓库版默认 `~/.memory-vault`（不存在）→ `memory_stats` 报 `unable to open database file`
- 修法：`MEM_VAULT` → `DSH_HOME/memory-vault` → `~/.memory-vault` 三级解析；
  装配侧同时给主实例补了 `env.MEM_VAULT`

重启后验证四件事：

1. `memory_stats` 能返回 571 卡 / 5958 原子（不再报错）
2. stats 里出现「查询向量缓存」「结果缓存」两行
3. 同一条 query 连问两次，第二次耗时从 ~250ms 掉到毫秒级
4. `memory_search` 带 `scope: ["domain:code"]` 不报错

### ② npm 发布

`npm view memory-kb2` 目前 404（包名可用）。用户已注册 npm 账号但还没登录。
登录用 `npm login --auth-type=web`（浏览器点授权，不用输密码），登录后：

```bash
cd ~/memory-kb2 && npm publish
```

发布成功后把 README 的安装段从 `npm i -g github:...` 改回 `npm i -g memory-kb2`。

### ③ README 补三节（防 issue）

- **没有 vault 时的引导**：现在直接报「索引不存在」，应提示「先放几张 md，再 `memory-kb2 index`」
- **不适用场景**：长文档问答、多用户、代码检索（grep 更准）
- **换库要重标参数**：`titleW` / `pool` 是为当前语料调的，换库效果可能回落

## 2. 今晚的结论（别重做）

### 2.1 检索算法已经到顶

| 评测 | 结果 | 对比 |
|---|---|---|
| 工程库 59 条有效题 | top1 **93.2%** / top3 **100%** | 自建标注，无公开对照 |
| 法学库概念名 | recall@1 **98.8%** | 自建 |
| 法学库正文（入索引后） | top1 **97.6%**（+93 条题） | 修复前 87.7% |
| PrecisionMemBench | **13.2%**（+scope 23.7%，+别名 26.3%） | 官方基线 12–14% |
| CodeRAG-Bench RepoEval | nDCG@10 **88.0** | Lucene BM25 **93.2**（输 5.2） |
| chat 2.2 M02 | A 39.2（120 条配对窗口 0 vs 6：**+0.9pp 无效**） | BM25+窗口 45.1（输 5.9） |
| chat 1.0 | **654/714 vs Qwen RAG 596** | 按 1.0 规则自测合法，**赢 8.1pp** |

**公开战绩：一赢（1.0）一平（PrecisionMemBench）两输（2.2 / CodeRAG）。**
没有「超过公开基线且端到端可复现」的成绩——PrecisionMemBench 的 26.3% 靠评测方喂 scope，不算。

### 2.2 能力边界

- **擅长**：一题一段的检索（查一张卡就够：配置、决策、概念、排障记录）
- **不擅长**：一题需要多段 evidence 拼接（2.2 的失败点：evidence 覆盖率中位 0.50）
- **完全不做**：长文档/图/多模态（输入是卡片，不是文档）、多用户、自动写记忆
- **为什么**：混合检索的收益 = 语料的「字面-语义缺口」。聊天 1.0 缺口大（赢 8.1pp），工程/法学/代码缺口小（打平或负）

### 2.3 已否决，别重试

多路召回的所有变体（多角度 BM25 50%→50%、多查询 RRF、查询级路由 90% vs 92%、两路加权 7/17→6/17）、
窗口保底 0→6（+0.9pp）、pool>80、limit 8→14（聊天 +3.3pp 但有天花板）、rerank 默认开（−4 条题 +341ms）、
bigram 当卖点（Lucene CJKAnalyzer 也是 bigram）。

## 3. 已落地的五项改动（都在仓库，可单独回滚）

| 提交 | 改动 | 实测 |
|---|---|---|
| `f6c7a62` | 修 `scripts/memory-index.mjs` 断链 + `MEM_VECTOR=0` 空跑 embedding | clone 后能跑 |
| `fd3fb5b` | 抽取式改写（别名表 + `hybridQuery.bm25Query`） | +1 条题，默认关 |
| `6386295` | scope 过滤（cards 加列、两路过滤、工具参数） | 13.2% → 23.7% |
| `d7055bf` | 检索结果缓存（key 含 `meta.built_at`） | 55ms → 1ms |
| `6f3148d` | 法学正文入索引（`MEM_BODY_SECTIONS`/`MEM_BODY_MAX`/剥 wikilink） | 正文 87.7% → 97.6% |
| `4f6c22c` | 文档与 eval 留档 | — |
| `21de336` | CodeRAG-Bench 评测装置 | 88.0 |
| `038ef0c` | vault 默认路径 + existsSync | 修生产启动 |
| `85c5687` | 安装改 git/tarball、files 补 bench/docs | 17 文件 |

## 4. 未落地的改动（在 `/tmp`，重启会丢）

- **沉淀逻辑改造**：`/tmp/me-src`（clone 自 `EternalNight996/dsh-memory-eternal` 的
  `github.com/EternalNight996/dsh-memory-eternal`）。已改三处：
  1. 每轮触发 → 空闲 debounce 5 分钟（`captureIdleMs`）
  2. 一次 0–1 张 → **0–3 张**（`maxCardsPerCapture`），空数组是默认
  3. 提示词加「主语 + 结论 + 可复用」三条门槛，`captureMinChars` 200 → 800
  实测：排障有结论 → 1 张卡；纯情绪 → 跳过；多主题 → 2 张；**长探索无结论 → 0 张**
  成本：20 轮会话从 20 次 LLM 调用降到 1 次
- 要落地需要把 `index.js` / `lib/capture.js` / `lib/capture-run.js` 替换回插件并装回

## 5. 环境事实

| 项 | 值 |
|---|---|
| 仓库 | `/home/nachogpt/memory-kb2`（HEAD `85c5687`） |
| 生产 vault | `/home/nachogpt/.dsh-web-lab/memory-vault`（571 卡 / 5958 原子） |
| 法学库 | `/home/nachogpt/WikiConstruct/vault`（941 卡 / 8468 原子） |
| MCP 装配 | `~/.dsh-web-lab/profiles/web/cordis.patch.yml`（两个实例都指向仓库版） |
| 装配备份 | `cordis.patch.yml.bak-20261120-033720-pre-kb2new` |
| 旧版 server | `~/dsh-armory/mcp/memory-server.mjs`（未动，回滚用） |
| 评测数据 | `/tmp/pmb`（PrecisionMemBench）、`/tmp/code-rag-bench`、`/tmp/t2`（T2Retrieval） |

## 6. 回滚

```bash
# 代码
git reset --hard 0b6a02f          # 回到今晚起点
# 或单独回退某一项：git revert <commit>

# 装配
cp ~/.dsh-web-lab/profiles/web/cordis.patch.yml.bak-20261120-033720-pre-kb2new \
   ~/.dsh-web-lab/profiles/web/cordis.patch.yml
# 然后重启 dsh web
```

## 7. 交接时的诚实结论（给用户看的）

这个项目**没有可复现的公开优势**。它的真实价值是三件：
1. 一个每天能用的个人检索工具（93.2/100，缓存命中 1ms）
2. 一份稀缺的证伪记录（20 轮实验、5 次「组件没用」、4 次观测错误）
3. 卡片生命周期语义（`active`/`status: deleted`），普通 RAG 没有

**不要**再以「更好的 RAG」定位它，也**不要**在任何公开榜上宣称排名。
