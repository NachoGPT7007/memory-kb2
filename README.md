# memory-kb2

MCP 记忆库：把本地 Markdown 卡片变成可检索的长期记忆。BM25 倒排 + 语义向量 + RRF 融合，不绑定客户端。

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
