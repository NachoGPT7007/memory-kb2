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

- **检索**：Client → MCP server → Index（BM25 + 向量两路召回）→ RRF 融合 → 去重 → 返回
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

```bash
git clone https://github.com/NachoGPT7007/memory-kb2 && cd memory-kb2
npm install

# 建索引（默认读 ~/.memory-vault）
MEM_VAULT=~/.memory-vault npm run index

# 自检
npm run selfcheck
```

接 MCP 客户端：

```json
{
  "mcpServers": {
    "memory_kb2": {
      "command": "node",
      "args": ["/absolute/path/to/memory-kb2/src/server.mjs"],
      "env": { "MEM_VAULT": "/absolute/path/to/your/vault" }
    }
  }
}
```

一个 MCP 进程绑一个库。要在同一会话里切多个库，就按库起多个实例。

---

## Measured

工程库 571 卡、59 条人工标注查询：

| 配置 | top1 | top3 |
|---|---:|---:|
| 纯 BM25 | **93.2%** | **100%** |
| + 向量 RRF | 92% | 100% |

延迟 p50 189 ms / p95 225 ms，其中 166 ms（88%）是一次远端 embedding 往返。

完整数据集、指标定义与全部实验数字见 [docs/BENCHMARK.md](./docs/BENCHMARK.md)。

---

## Docs

| 文档 | 内容 |
|---|---|
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

## Roadmap

- [ ] 多跳检索：目前只到第一跳基线
- [ ] 外置向量库：万卡级时全量向量加载会吃内存
- [ ] 英文语料适配：分词、停用词、标题权重都按中文调过

---

## Contributing

Issue 用于讨论，PR 欢迎但按现状维护、不承诺跟进节奏。提交前请跑 `npm run selfcheck`。

---

## License

MIT。详见 [LICENSE](./LICENSE)。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
