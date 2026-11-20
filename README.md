# memory-kb2

MCP 记忆库：把本地 Markdown 卡片变成可检索的长期记忆。BM25 倒排 + 语义向量 + RRF 融合，不绑定客户端。

**面向 Agent 的知识库，不是陪伴型长记忆。** 它记的是「这个项目为什么这么决定」「这个结论后来被推翻了」，不是聊天记录。所以它关心结论是否仍然成立（归档语义），也关心不同语料要用不同参数（三档 Profile）。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2022-brightgreen.svg)](./package.json)
[![Protocol](https://img.shields.io/badge/protocol-MCP-orange.svg)](https://modelcontextprotocol.io/)
[![Retrieval](https://img.shields.io/badge/retrieval-BM25%20%2B%20vector%20%2B%20RRF-4D6BFE.svg)](./docs/MECHANISM.md)

---

## Why

会话结束，上下文就没了。你上周讨论过的方案、踩过的坑、做过的决定，下次开新会话时它一个字都不记得。

把记忆塞进 system prompt 能撑一阵，但几百张卡之后就撑不住了——不是超长，就是淹没了真正相关的那几条。检索是唯一的出路。

而检索的坑比想象中深。这个项目在 20 轮控制变量实验里，有五次得出「某个组件没用」的结论，其中**四次最后追溯到观测手段的问题**：查询取自卡正文、送进重排的是 40 字碎片、候选池只有 20、零成本模拟替代真实实现。这些过程全部留在 [DEBUG-LOG.md](./docs/DEBUG-LOG.md) 里，包括被推翻的结论。

起点更具体一点：[ORIGIN.md](./docs/ORIGIN.md) 记录了它为什么被做出来——以及一个库说「标题权重越大越差」、另一个库说「×3 最好」时，怎么判断谁对。

---

## Features

- **混合检索**：BM25（`node:sqlite` 内建）+ 向量召回 → RRF 融合 → 内容去重
- **零外部检索依赖**：BM25 走 Node 内建 SQLite；向量与重排可选，无凭据自动退回 BM25-only
- **场景档位自动识别**：启动时按语料特征判一次（wiki / chat / engineering），不用手工切环境变量
- **自适应候选池**：`clamp(1.09·√cards, 20, 80)`，池深随库规模走
- **归档卡片语义**：`status: deleted` 的结论默认不返回，查历史决策时显式打开
- **可证伪的自检**：`selfcheck.mjs` 检查索引自洽、归档规模、候选池不变量、延迟构成、服务层准确率
- **不绑定客户端**：任何支持 MCP 的客户端都能连

---

## Architecture

[![memory-kb2 architecture](./docs/assets/architecture.png)](./docs/assets/architecture.png)

检索与索引是两条链路，共用一份索引：

- **两个入口**：MCP Client（给 AI 用，经 stdio 服务）与 CLI（给人用，直接读写索引）
- **检索**：入口 → Index（BM25 + 向量两路召回）→ RRF 融合 → 去重 → 返回
- **索引**：vault（Markdown）→ indexer（切原子 + 分词）→ Index
- **可选路径**：Embedding API 提供查询向量，Rerank API 做精排——两条都可关闭
- **Profile 路由**：启动时按语料特征判一次，换库不用改配置


### 数据流：从卡片到结果

```mermaid
flowchart TB
  subgraph IDX["索引链路 · 离线"]
    direction LR
    V["vault<br/>*.md 卡片"] --> A["切原子<br/>小节标题优先 + 30–400 字窗"]
    A --> T["分词<br/>中文二元组 + 停用词"]
    T --> B["BM25 打分<br/>k1=1.2 · b=0.75 · titleW=3.0"]
    A -.-> E["向量化<br/>批量编码 · 可选"]
    B --> S[("SQLite<br/>倒排 + 元数据")]
    E -.-> W[("vectors.f32<br/>原子向量")]
  end

  subgraph QRY["检索链路 · 在线"]
    direction LR
    Q["query"] --> QT["查询分词<br/>同一套二元组"]
    QT --> BM["BM25 召回<br/>pool 条"]
    Q -.-> QE["查询向量化<br/>约 166 ms"]
    QE -.-> VR["向量召回<br/>cosine topK"]
    W -.-> VR
    BM --> RRF["RRF 融合<br/>score = Σ 1/(60 + rank)"]
    VR -.-> RRF
    RRF --> POST["去重 + 归档过滤<br/>原子级 · status: deleted"]
    POST --> RE["重排<br/>可选 · 默认关"]
    POST --> LIM["limit 截断"]
    RE -.-> LIM
    LIM --> RES["返回结果"]
  end

  S -.->|同一份索引| BM
```

实线是默认路径，虚线是可选路径（向量与重排都有凭据才启用）。

每一步的参数与实测依据：

| 步骤 | 参数 | 依据 |
|---|---|---|
| 切原子 | 30–400 字窗口，小节标题优先 | 更碎则噪声大，更长则语义分散 |
| 分词 | 中文二元组 + 停用词 | 零词典依赖；59 条标注 top1 93.2% |
| BM25 | k1=1.2 / b=0.75 | 实测 0.2–0.75 区间排序不变，用默认值 |
| 标题权重 | titleW=3.0 | 与 1.3 在 59 条上打平，概念名查询略优 |
| 候选池 | clamp(1.09·√cards, 20, 80) | 571 卡→26，5413 卡→80（两个拟合点） |
| RRF | k=60 | 常数，排名融合不依赖分数尺度 |
| 去重 | 正文前 160 字指纹 | 真实库存在完整副本，去重后 top5 唯一内容 3.60→5.00 |
| 归档过滤 | 原子级 active 标志 | 卡级过滤会漏掉「部分结论已归档」 |
| 重排 | 输入必须是完整 chunk | 喂 40 字原子碎片会让结论反转 17pp（第 16 轮） |

### 三档 Profile

| 档位 | 判定条件 | limit | 向量 | rerank | 实测 |
|---|---|---:|---|---|---|
| **engineering**（默认） | 其余 | 5 | 开 | 关 | 571 卡 59 题：top1 93.2% / top3 100%，p50 189 ms |
| **wiki**（法学） | 平均标题 < 15 字 | 8 | 关 | 关 | 941 卡：BM25 MRR 0.529 > dense 0.434；概念名 recall@1 98.9% |
| **chat**（已冻结） | 原子/卡 ≤ 3 且正文均长 < 800 字 | 14 | 开 | 开 | 5413 卡 · pool 80：命中 65% / 覆盖 0.588 |

三档的差异不是拍脑袋定的：法学卡是概念名驱动的，标题即答案，密集向量的语义泛化反而引入近义干扰（dense 0.434 < BM25 0.529），所以 wiki 档关向量；聊天库要想起多轮细节，名额与召回宽度更关键，所以 limit 14 + 向量 + 重排全开。

`chat` 档冻结，是因为 evidence 命中 48.3% 的天花板在**名额分配**而非检索链路——再调算法没有意义。冻结的含义与依据见 [docs/DEBUG-LOG.md](./docs/DEBUG-LOG.md) 第 20 轮。

细节见 [docs/MECHANISM.md](./docs/MECHANISM.md)。

---

## Quick start

### 安装

```bash
npm install -g memory-kb2        # 需要 Node ≥ 22
```

想跟最新提交或改代码，用仓库：

```bash
git clone https://github.com/NachoGPT7007/memory-kb2 && cd memory-kb2 && npm install
```

Node 22 起才有内置的 `node:sqlite`——这是「零外部检索依赖」的前提，版本不够直接装不上。

### 第一次用：还没有 vault

`MEM_VAULT` 指向的目录就是库。**它不会替你挑内容**：没有卡片就没有记忆可检索，索引再新也是空的。

```bash
mkdir -p ~/notes          # 1. 准备目录，放 2–3 个 .md 卡片
MEM_VAULT=~/notes memory-kb2 index                 # 2. 建索引
MEM_VAULT=~/notes memory-kb2 search "某个结论"      # 3. 确认查得出来
```

一张卡最少是这样——`title` 加上回答型小节（`结论` / `要点` / `根因` 等标题下的正文才进索引）：

```markdown
---
title: 检索融合为什么用 RRF
status: active
---

## 结论

BM25 分数没有上界，向量相似度在 [0,1]，两路不可比。排名是唯一共同的度量。
```

两张现成的卡在 [`examples/minimal-vault`](./examples/minimal-vault)，可以直接照抄结构。

**空库的两种表现不一样，别混**（2026-11-20 实测）：

| 入口 | 行为 |
|---|---|
| `memory-kb2 index` 指向不存在的目录 | **exit 0**，建出 0 卡 / 0 原子的空索引；之后 `search` 全部无命中，但**不报错** |
| MCP `memory_stats` / `memory_search`，索引文件不存在 | 工具错误 `unable to open database file` |

所以「查不到东西」先看 `memory-kb2 stats` 的卡片数：0 卡是没放卡，不是检索坏了。

### 命令行：给人用

```bash
memory-kb2 index                      # 建索引
memory-kb2 stats                      # 库有多大、倒排多少项、归档几张
memory-kb2 search "候选池为什么"       # 命令行检索，看命中与分数
memory-kb2 selfcheck                  # 本体体检
```

**要指向你自己的笔记目录**，加一个环境变量即可：

```bash
MEM_VAULT=~/notes memory-kb2 index
```

不设 `MEM_VAULT` 时**两个入口的查找顺序不同**：MCP 服务按 `$DSH_HOME/memory-vault` → `~/.memory-vault` 依次找；
CLI（`index` / `search` / `stats`）只认 `MEM_VAULT` 或 `~/.memory-vault`，不看 `DSH_HOME`。
要避免这种歧义，就显式写 `MEM_VAULT`。

### MCP 客户端：给 AI 用

全局装过之后，配置只有三行：

```json
{
  "mcpServers": {
    "memory_kb2": {
      "command": "memory-kb2",
      "args": ["serve"],
      "env": { "MEM_VAULT": "/你的/笔记目录" }
    }
  }
}
```

`env` 里那一行建议写上——省略时 MCP 服务按 `$DSH_HOME/memory-vault` → `~/.memory-vault` 找。
一个 MCP 进程绑一个库；要同时查多个库，就按库起多个实例（同一条命令，换 `MEM_VAULT`）。

---

## 不适合用它做什么

这份清单来自实验记录，不是免责声明——每一条都有对应的失败数字或未实现的环节：

| 场景 | 为什么不适合 | 证据 |
|---|---|---|
| 长文档问答 / 全文检索 | 输入单位是卡片切成的小节原子，不是 PDF 或长文。要查长文，得先把结论写成卡 | 正文只收「结论 / 要点 / 根因」这类回答型小节，叙述性正文不进索引 |
| 代码检索 | 中文二元组分词对代码结构无效，别拿它替代 grep | CodeRAG-Bench RepoEval：nDCG@10 **88.0**，Lucene BM25 **93.2**（输 5.2） |
| 需要多段 evidence 拼答案 | 一题一段时 top1 93.2%；一题要多段拼接时，证据覆盖率中位数只有 0.50 | chat-memory-benchmark 2.2 实测 A 39.2，低于基线 45.1 |
| 多用户 / 并发写 | 一个 vault 一个 SQLite 文件，写入靠整体重建索引；没有权限模型、没有租户隔离 | 未实现 |
| 自动沉淀记忆 | 不会自己从对话里抽卡。只有 `memory_update` 让人显式追加修正或标记失效 | 未实现 |
| 图文 / 多模态 | 只索引文本 | 未实现 |

**它擅长的是**一题一段的精准召回——查一个配置、一条决策、一次排障记录、一个概念的定义。
这类查询上工程库 top1 93.2% / top3 100%，法学概念名 recall@1 98.9%。

---

## Measured

工程库 571 卡、59 条人工标注查询：

| 配置 | top1 | top3 |
|---|---:|---:|
| 纯 BM25 | **93.2%** | **100%** |
| + 向量 RRF | 92% | 100% |

延迟 p50 189 ms / p95 225 ms，其中 166 ms（88%）是一次远端 embedding 往返。

完整数据集、指标定义与全部实验数字见 [docs/BENCHMARK.md](./docs/BENCHMARK.md)。

**本项目没有向公开榜提交过成绩。** PrecisionMemBench（纯检索断言基准）实测 10/76 = 13.2%——与官方基线（Qwen3 14.3%、Hindsight 14.3%、Mem0 11.7%）持平——详见 [BENCHMARK 第 11 节](./docs/BENCHMARK.md)。 与 chat-memory-benchmark 1.0 / 2.2 的关系、以及为什么自测数字不能直接和榜上 A 分比较，写在 [BENCHMARK 第 10 节](./docs/BENCHMARK.md)——那一节也列出了聊天域偏弱、只在两个合成人物上测过这些坏消息。

---

## 换库要重标参数

下面的默认值是从三个真实库（工程 571 卡 / 法学 wiki 941 卡 / 聊天 5413 卡）调出来的，不是普适最优。
换一份语料，这几项最先失效：

| 参数 | 默认 | 覆盖方式 | 为哪类语料调的 |
|---|---|---|---|
| `titleW` | 3.0（档位）/ 1.3（库函数兜底） | `MEM_TITLE_W` | 标题即答案的概念卡。概念名查询 1.0→2.0：工程 93.0%→99.6%、法学 80.1%→95.9%；描述性查询相反，3.0 时 −3.4pp |
| `pool` | `clamp(1.09·√cards, 20, 80)` | `MEM_POOL` / `MEM_POOL_MIN` / `MEM_POOL_MAX` | 拟合点只有两个（571→26、5413→80）。卡数落在中间地带时，这条曲线没有实测支撑 |
| 档位阈值 | 标题均长 15 字 · 原子/卡 3 · 正文均长 800 字 | 不自动，用显式环境变量压过档位 | 三个库的分界；第四个库落在哪一档，没验证过 |
| 正文小节词表 | `排障 / 要点 / 结论 / 根因 …` | `MEM_BODY_SECTIONS` | 默认词表是工程与聊天语域。法学卡章节名（体系位置 / 内容 / 效果 / 例外与争议）一条都不匹配，385 万字正文因此零入索引——**换领域必查这一项** |

**重标顺序别反过来：**

1. 看现状：卡片数用 `memory-kb2 stats`；**判成哪一档只有 MCP `memory_search` 的返回头会打印**（形如 `engineering档·标题权×3`），CLI 不显示档位
2. 自己标 **50 条以上**查询——低于 50 条不下结论，这是本项目的硬规则（15 条时看到的 +7pp，扩到 59 条变成打平）
3. 跑一次基线 top1 / top3，再**一次只动一个参数**
4. 只保留方向一致、幅度超过噪声的改动

不重标不一定会坏。坏的是出了问题你分不清是参数、语料，还是卡本身写得不行。

---

## Docs

| 文档 | 内容 |
|---|---|
| [HANDOFF](./docs/HANDOFF.md) | 交接与实验计划：三刀的变量、对照组、判定标准、回滚点 |
| [GAP](./docs/GAP.md) | 与企业级 RAG 的逐环节对比：14 个环节里缺了哪些，为什么端到端打不过 |
| [ORIGIN](./docs/ORIGIN.md) | 为什么做、怎么变成现在这样。含 title 权重 1.0/1.3/3.0 的两次校准与架构之争 |
| [MECHANISM](./docs/MECHANISM.md) | 卡片与原子、索引构建、检索链路、RRF、候选池、档位判定、一致性保障 |
| [TUNING](./docs/TUNING.md) | 每个参数的取值依据，含**被证伪的参数**与已知未解五项 |
| [BENCHMARK](./docs/BENCHMARK.md) | 数据集与指标、全部实测数字、延迟分解、可证伪的候选池不变量 |
| [DEBUG-LOG](./docs/DEBUG-LOG.md) | 20 轮调试全过程，保留全部被推翻的结论 |

---

## Project layout

```
memory-kb2/
├── src/
│   ├── server.mjs        MCP 服务：memory_search / memory_update / memory_stats
│   ├── index.mjs         索引器：切原子、分词、BM25 倒排、可选向量
│   └── embed-api.mjs     Embedding / Rerank 的 HTTP 适配层
├── scripts/
│   └── selfcheck.mjs     本体体检：索引自洽、候选池不变量、延迟构成、准确率
├── docs/                 机制、调参、基准、调试史
└── examples/             最小的 vault 示例
```

---

## 状态与路线

### 已经到顶的

| 能力 | 指标 | 判断依据 |
|---|---|---|
| 工程库精确检索 | top1 93.2% / top3 100%（59 条） | 剩余失败题为标注串模糊 |
| 法学 wiki 概念名 | recall@1 98.9%（940 卡） | 标题即答案，加权已饱和 |
| 延迟 | p50 189 ms | 其中 166 ms 是 embedding 往返，属结构性，调参无解 |

### 有证据的待办

| 事项 | 已有信号 | 缺什么 |
|---|---|---|
| 重叠聚类按簇分配名额 | 模拟中覆盖 +35~43% | 未落地到生产 |
| 时间维度（到点/今天到期类） | 自然榜 X4 类召回为 0 | 未验证；且卡片 mtime、frontmatter、正文时间三者常不一致，先要定用哪个 |
| 法学库原子数不一致 | 首次 15718、后续 8468，两次数字对不上 | 缺可重复的最小样本 |
| 正文未进索引 | 已知：wiki 卡片正文不参与检索 | 属设计待定，改了会影响 wiki 档 |

### 边界：做了一半或数据不足的

| 事项 | 现状 | 缺什么 |
|---|---|---|
| **冷热分层**（hot / warm / cold / dead） | 已在 `selfcheck` 里实现：按召回账本算四层比例与标记漂移。**但它只做统计，没有参与检索**——hot 卡不会因为「热」而排前 | 分层要进检索，先得有可信的账本。当前账本只有 13 次检索，cold/dead 判定不可信（检查项自己会报这条） |
| **反向关联 / 二次检索** | 会话记录里未找到完整实验数据，无法给出结论 | 需要重新定义「什么算关联」并跑一次基线 |

### 已否决，不再列入路线

| 方向 | 否决依据 |
|---|---|
| **多跳检索** | 桥接精度 1–3%（跳出去 610 条只有 18 条是答案依据）；工程库 top3 已 100%，只有下降风险。详见 [DEBUG-LOG](./docs/DEBUG-LOG.md) 第 20 轮 |
| 查询级路由 | 59 条上 90% vs 统一 92%，持续证伪 |
| BM25F 字段加权 | 模拟 +17.5pp，实现 −21.7pp |
| 多角度 BM25（句法切分） | 命中 50.0% → 50.0%，切出的片段与原句共享同一批 bigram |
| rerank 默认开 | 修正评测输入后与无重排打平（90% vs 92%），多付 0.8 秒 |
| 外置向量库 | **无实测依据**。此前写在这里是推测：万卡级规模从未出现过，`vectors.f32` 全量加载的实际内存占用没有测过 |

完整的功能账本（保留 9 项 / 撤掉 13 项及原因）见 [ORIGIN 第 3 节](./docs/ORIGIN.md)。

## Contributing

Issue 用于讨论，PR 欢迎但按现状维护、不承诺跟进节奏。提交前请跑 `npm run selfcheck`。

---

## 设计来源

- **[memory-eternal](https://github.com/EternalNight996/dsh-memory-eternal)**（EternalNight996，MIT）
  本项目的前身。vault 的卡片结构、以及「对话结束自动沉淀成卡」的思路来自它。
  kb2 在它之上重写了检索链路：BM25 倒排 + 向量召回 + RRF 融合 + 三档 Profile。
- **[chat-memory-benchmark](https://github.com/Ornn8/chat-memory-benchmark)**（Ornn8）
  聊天域题库 M01 / M02 的来源。它是面向**陪伴型** AI 的中文记忆基准，
  而 kb2 是 Agent 知识库——借它的题库只用于测「长对话里的细节召回」这一项能力，
  不在于定位相同。哪一档因此冻结，见 [DEBUG-LOG 第 20 轮](./docs/DEBUG-LOG.md)。
- **[Archify](https://github.com/tt-a1i/archify)**（tt-a1i，`@tt-a1i/archify-dsh`）
  本 README 架构图的绘制工具。
- **RRF** —— Cormack、Clarke、Büttcher，SIGIR 2009。

依赖见 `package.json`，不在此列。

---

## License

MIT。详见 [LICENSE](./LICENSE)。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
