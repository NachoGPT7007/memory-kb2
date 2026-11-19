# memory-kb2

**给 AI 装一个自己的长期记忆。**

会话结束，上下文就没了。你上周讨论过的方案、踩过的坑、做过的决定，下次开新会话时它一个字都不记得。把记忆塞进 system prompt 能撑一阵，但几百张卡之后就撑不住了——不是超长，就是淹没了真正相关的那几条。

这个项目把记忆放在本地的一堆 Markdown 卡片里，用一个 MCP 服务对外提供检索：**BM25 倒排 + 语义向量 + RRF 融合**。它不绑定任何客户端——Claude Desktop、Cursor、Cherry Studio，凡是支持 MCP 的都能连。

```
vault/                      你的知识库（纯 Markdown，人可读、Git 可管）
├── 02-Projects/            项目决策、踩坑记录
├── 03-Knowledge/           概念与结论
└── .index/                 索引产物（可随时重建）
    ├── memory.sqlite       BM25 倒排 + 卡片元数据
    └── vectors.f32         向量（可选）
```

---

## 实测水平

不是估计值。工程库 571 张卡、59 条人工标注查询：

| 配置 | top1 | top3 |
|---|---:|---:|
| 纯 BM25 | **93.2%** | **100%** |
| + 向量 RRF | 92% | 100% |

**向量在这个库上没带来收益**，所以它默认开只是为了别的域——工程档真正的理由是「不更差」，不是「更好」。这个结论是在推翻了两次错误测量之后才站住的。

延迟：p50 189 ms、p95 225 ms。其中 166 ms（88%）是一次远端 embedding 往返，本地检索本身只要 3 ms 量级。

聊天域（5413 卡，40 题）：命中 65%、覆盖 0.588——但这是把候选池从 20 放到 80 之后才达到的；池子太浅时，重排和融合都会「看起来没用」。

---

## 快速开始

```bash
npm install
MEM_VAULT=~/.memory-vault npm run index     # 建索引
npm run selfcheck                            # 自检
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

## 文档

这份 README 只给结论。支撑结论的东西在 `docs/` 里，**每一个数字都能追到具体轮次和样本量**：

| 文档 | 内容 |
|---|---|
| [docs/MECHANISM.md](docs/MECHANISM.md) | 从头到尾的机制：卡片与原子、索引构建、检索链路、RRF、候选池、档位判定、一致性保障 |
| [docs/TUNING.md](docs/TUNING.md) | 每个参数的取值依据，含**被证伪的参数**（BM25F、查询路由）与已知未解五项 |
| [docs/BENCHMARK.md](docs/BENCHMARK.md) | 数据集与指标定义、全部实测数字、延迟分解、可证伪的候选池不变量 |
| [docs/DEBUG-LOG.md](docs/DEBUG-LOG.md) | 20 轮调试全过程，**保留全部被推翻的结论** |

如果只读一篇，读 DEBUG-LOG。它记录的是五次「某个组件没用」的结论，其中四次最后被证明是观测手段的问题——这个模式比任何单个参数都更值得知道。

---

## 已知边界

- **需要 Node 22+**：索引依赖内建的 `node:sqlite`
- **中文优先**：分词、停用词、标题权重都按中文卡片调过，英文库未测
- **不是向量数据库**：卡片到万级时全量向量加载开始吃内存，届时需要外置向量库
- **重排默认关**：工程类短卡片上无收益且多付约 0.8 秒；但候选池够深时它对长文档语料是有增益的

---

## 设计来源

RRF（Reciprocal Rank Fusion）来自 Cormack、Clarke、Büttcher 在 SIGIR 2009 提出的排名融合方法，本项目的混合检索按这一思路实现。

依赖见 `package.json`，不在此列。

---

## 许可

MIT。
