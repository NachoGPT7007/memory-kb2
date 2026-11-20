# 交接 2026-11-20 下午：CodeRAG 定位到顶 + 记忆插件修复

> 本文取代凌晨那份 `NEXT-SESSION-2026-11-20.md` 的「立刻要做」清单（那三件已完成或作废）。
> 机制见 `MECHANISM.md`，参数依据见 `TUNING.md`。

## 0. 一句话

**CodeRAG 从 87.5 做到 93.2（打平论文 BM25 基线），根因是「代码语料落进按空行切段落的兜底路径」；
记忆插件的监听点在 DSH 升级后静默失效，已改为 `session/event` 并完成装配，写入验证待重启确认。**

## 1. CodeRAG：参数层已排除，根因在切分

### 1.1 十二组单变量实验（373 条全量）

| 组 | 改动 | nDCG@10 |
|---|---|---:|
| A | 默认 | 87.5（复现，原记录 88.0） |
| B | 入库时拆标识符（SPLIT_IDS=1） | **82.7**（假设被否定，6/6 仓库全降） |
| C | 关覆盖率因子（MEM_COVER_POW=0） | 88.6 |
| D | 覆盖率线性（=1） | 86.3 |
| E | 整窗不切块（CHUNK=0） | 88.0 |
| F | E+C | 88.8 |
| G | 空白分词（MEM_TOKENIZER=ws） | 88.9 |
| H | 空白分词不过滤（ws_raw） | 88.9 |
| I | C+E+H 合计，仍按段落切 | 90.0 |
| **K** | **+ 整卡入库（MEM_BODY_WHOLE=1）** | **93.2** |

论文 Table 3（CodeRAG-Bench, arXiv 2406.14497）RepoEval 列：BM25 **93.2**，
Codesage-small 94.1、Voyage-code 94.3、OpenAI-03 93.0、Jina-v2-code 90.5。

### 1.2 根因（已定位到源码）

`src/index.mjs` 的 `build()` 里，正文入库只有两条路：

1. 命中「回答型小节」词表（`BODY_SECTIONS`：排障/要点/结论/根因…）
2. 兜底：`bodyRaw.split(/\n\s*\n/)` 按空行切段落

代码文件没有 Markdown 标题 → 第一条永不命中 → 全部落进兜底 →
**一个 function 平均切成 11.6 个原子**（实测 739 卡 / 8617 原子）。

原子级 BM25 的三重偏差：
- 长度归一化基准是「段落」不是「函数」
- tf 不跨段累加（长 query 的词分散在不同段，拼不齐一次完整匹配）
- idf 的 `N` 从文档数变成原子数（放大 11.6 倍）

而官方 baseline 是「一个 function 一个文档」+ `JWhiteSpaceAnalyzer`（见
code-rag-bench 的 `modify_corpus_for_bm25.py` 与 `eval_beir_pyserini_repo.py:129`）。

### 1.3 修复（已落地，默认生效）

`src/index.mjs` 的兜底路径加 `wholeBody`：

```js
const wholeBody = process.env.MEM_BODY_WHOLE === '1' || card.kind === 'code'
const maxLen = wholeBody ? Math.max(BODY_MAX, 200000) : BODY_MAX
```

- `kind: code` 自动整卡入库，并放宽长度上限（否则 >400 字的函数会被整条丢掉）
- 生产中文库零影响：`kind` 分布是 knowledge/mistake/tool/project/prompt/content，
  **没有一张 kind: code**；已用 HEAD 版本对照重建验证（两者都是 571 卡 / 6031 原子 / avgdl 53.02）

### 1.4 仍未做 / 数据已丢

- **实验数据与数据集已随 `/tmp` 清空丢失**：十二组 JSON、`code-rag-bench`（1.3G）、
  所有 vault 副本。重跑需重新下载数据集：`github.com/code-rag-bench/code-rag-bench`。
- 93.2 是**打平**不是超过；code 专用 embedding 仍在我们之上（94.1 / 94.3）。
- 单一数据集（6 仓库 / 373 条），换仓库类型可能不同。
- `MEM_COVER_POW=0` 对 CodeRAG +1.1、工程库零变化，但**默认值未改**（还在 0.35），
  要改需另做一轮回归。

## 2. 记忆插件：另一条线，根因已定位并修复

### 2.1 根因

插件原本监听 `agent/turn-stopping`。该事件由 `agentEvents.serial(carrier, ...)` 派发，
`carrier = agentCarrier(agent)` 带 `Context.filter`（见 dsh-agent 的 `scopeTarget`）。
cordis 的 `_resolve` 用这个 filter 过滤监听器：

```js
(this._hooks[name] || []).filter((hook) => hook.global || !filter || filter.call(thisArg, hook.ctx))
```

→ **根 ctx 上注册的 listener 收不到**。DSH 升级后，`dsh-memory-kb2` 与
`@dsh-external/dsh-memory-sink` 两条线同时静默失效（sink 从未写入过任何卡）。

### 2.2 修复

改成无 carrier 的 `session/event`，在 `turn/end` 时沉淀（宿主 `dsh-goal` 也用这条）：

```js
ctx.on('session/event', (session, event) => {
  if (event?.type !== 'turn/end') return
  ...
  scheduleCapture(session, events, lastSeq)
})
```

连带把 `scheduleCapture` / `runCapture` 内的 `agent?.session?.id` 全改为 `session?.id`（5 处）。

### 2.3 沉淀条件（已改代码，待重启生效）

- 提示词加：**重要性证据 = 概念/结论必须被反复提及或多轮印证**；情绪宣泄不沉淀；
  允许在不新增事实的前提下改写（针对「从句子开头硬抽抽不到主语」）
- `captureMinChars` 200 → 800（schema 与 `~/.dsh-web-lab/memory-eternal-config.json` 两处）

### 2.4 未做

- **按任务而非按轮**：现在仍每轮 `turn/end` 触发；`captureCooldownMs=300000` 只是
  两次 capture 的最小间隔，不是「空闲 5 分钟后回看整个任务」。改它是动调度结构。
- **一次产出 0–3 张**：现在一次调用产 0 或 1 张。改成数组要动三处联动
  （提示词输出格式 / `parseCaptureJson` / `runCapture` 写卡循环）。

## 3. 当前状态

| 项 | 状态 |
|---|---|
| kb2 检索（MCP） | 正常，工程库 93.2 / 100 |
| CodeRAG 修复 | 代码已改，默认生效（`kind: code` 整卡入库） |
| 记忆插件装配 | `dsh-armory/packages/dsh-memory-kb2`，已 `loader.create` 热装配 |
| 插件写入 | **未验证**——需重启 dsh web 让修复后的代码真正加载 |
| 装配备份 | `profiles/web/{package.json,cordis.patch.yml}.bak-20261120-pre-memory-kb2` |

### 3.1 记忆库探索原语（2026-11-20 新增，本轮已实测）

参照两个蓝本补齐「Agent 如何探索记忆库」：

- **Aider 的 repo map**（https://aider.chat/docs/repomap.html）：给 LLM 全库符号地图
  （tree-sitter 提取 → 文件依赖图 → 图排序 → 在 `--map-tokens`（默认 1k）预算内选最重要的部分），
  LLM 看完地图再**按需索取具体文件**。
- **RAGFlow 1.0**：Agentic Retrieval（分析问题 → 必要时分解 → 检索 → 验证证据）+ 引用溯源。

kb2 此前只有 `memory_search`（黑盒检索），Agent 不知道库里有 571 张卡、也打不开检索到的卡。
新增两个只读工具：

| 工具 | 作用 | 实测 |
|---|---|---|
| `memory_map` | 按目录列出全部卡标题+路径+日期，带字符预算（默认 8000，上限 40000），超限截断并提示用 `dir` 收窄 | `dir=02-Projects` → 88 张卡 / 2021 字符，截断正常 |
| `memory_get` | 按 path 读整张卡（frontmatter + 全文），带路径穿越防护 | 读到 1718 字符完整卡；`../../etc/passwd` 被拒 |

**MVP 的边界**：`search`（精准）+ `map`（有什么）+ `get`（读全卡）+ 摄入（对话沉淀）
构成一个闭环。以下**不属于 MVP**，但蓝本里有、后续要补：

- Agentic 多步检索（分解问题、多轮检索、验证证据）
- 反馈闭环（哪张卡被用上了 → 影响排序）
- 知识编译（Wiki / Graph / Timeline 等结构化产物）
- 上下文组装（一次返回多卡 + 关系标注，而不是零散片段）

### 3.2 上下文组装 + 分步检索（2026-11-20 本轮，全部复用既有组件）

原则：能复用就复用，不新建索引、不新建存储。

| 改动 | 复用的是什么 |
|---|---|
| `memory_search` 每卡返回「路径 + 更新日期 + 状态 + 结论段（180 字）」 | 已有的 `cards.mtime/status` 与命中原子（`hitAtoms`），一次批量 SQL，不改排序 |
| 末尾给「同目录还有未返回的卡，例如 …——要读全文用 memory_get」 | 已有的 `cards` 表 + `path LIKE` 查询，作为分步检索的下一跳线索 |
| `memory_get` 每次读取落一行账本 | **复用已有的 `memory-recall-ledger.jsonl`**（原供 `scripts/memory-recall-stats.mjs` 做区域加权），新增 `action: "get"` 区分 |

状态只在「非正常」时显示（`deleted`/`rejected`/`pending`）；`active`/`approved` 是常态，不占位置。

**这就是「分步检索」在 MCP 里的形态**：Agent 自己转循环（查 → 判断够不够 → 再查），
server 的职责是让每一转都有信息量（可判断的材料 + 下一跳线索 + 能读全卡）。
不是 server 内部调 LLM 做多轮。

实测（生产库）：`search("vault 路径解析", limit=2)` 返回两张卡带结论段与日期，
并提示「同目录（03-Knowledge）还有未返回的卡，例如 …——要读全文用 memory_get」；
`memory_get` 后账本新增 `{"action":"get","path":"…"}`。



## 4. 下一步

1. 重启 `dsh-lab-web` → 验证：本轮结束后 `vault` 是否新增卡（此前 10 天 0 张）
2. 写入验证通过后，再做「按任务 debounce」与「0–3 张」
3. 若要提交 CodeRAG 成绩，需先重下数据集重跑并把结果归档进 `eval/`

## 5. 回滚

```bash
# 检索侧
git revert <本次提交>        # 或 git checkout HEAD -- src/index.mjs

# 插件装配
cp ~/.dsh-web-lab/profiles/web/package.json.bak-20261120-pre-memory-kb2 \
   ~/.dsh-web-lab/profiles/web/package.json
cp ~/.dsh-web-lab/profiles/web/cordis.patch.yml.bak-20261120-pre-memory-kb2 \
   ~/.dsh-web-lab/profiles/web/cordis.patch.yml

# 插件代码
cd ~/dsh-armory/packages/dsh-memory-kb2 && git checkout -- .   # 或删目录后从 git 恢复
```

## 6. 诚实结论

- CodeRAG 现在**打平**官方 BM25 基线，不是超过；论文里 code 专用 embedding 仍领先。
- 实验数据没归档就丢了，这是**流程缺陷**：以后跑评测先把数据集位置与结果写进 `eval/`，
  否则「可复现」永远只是一句话。
- 记忆插件的修复只解决了「能不能写」，还没解决「写什么值得」——沉淀条件的三项
  （按任务 / 反复提及 / 0–3 张）才刚开头。
