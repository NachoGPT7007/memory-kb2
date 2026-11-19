# memory-kb2

**给 AI 装一个自己的长期记忆。**

会话结束，上下文就没了。你上周讨论过的方案、踩过的坑、做过的决定，下次开新会话时它一个字都不记得。把记忆塞进 system prompt 能撑一阵，但几百张卡之后就撑不住了——不是超长，就是淹没了真正相关的那几条。

这个项目把记忆放在本地的一堆 Markdown 卡片里，用一个 MCP 服务对外提供检索：**BM25 倒排 + 语义向量 + RRF 融合**。它不绑定任何客户端——Claude Desktop、Cursor、Cherry Studio，凡是支持 MCP 的都能连。

---

## 它做什么

```
vault/                      你的知识库（纯 Markdown，人可读、Git 可管）
├── 00-System/
├── 01-Profile/
├── 02-Projects/            ← 项目决策、踩坑记录
├── 03-Knowledge/           ← 概念、结论
├── 04-Content/
├── 05-Prompts/
└── .index/                 ← 索引产物（可随时重建）
    ├── memory.sqlite        BM25 倒排 + 卡片元数据
    └── vectors.f32          向量（可选）
```

`src/server.mjs` 作为 MCP stdio 服务暴露检索工具；`src/index.mjs` 负责把 vault 建成索引。

### 检索链路

1. **BM25**：`node:sqlite` 内建，零外部依赖，倒排索引按时效加权
2. **向量**：可选。走 OpenAI 兼容的 embeddings 端点（默认配的是通义千问），API 不可用时退回 BM25-only
3. **RRF 融合**：两路结果按倒数排名融合，避免任何一路的分数尺度问题
4. **重排**：可选。默认关闭，按库类型决定是否开启

三路都是可开关的，不配向量也能用。

---

## 实测数据

不是理论值。工程库 571 张卡、59 条人工标注查询：

| 配置 | top1 | top3 |
|---|---:|---:|
| 纯 BM25 | 93.2% | 100% |
| + 向量 RRF | 92% | 100% |

**向量在这个库上没带来收益**，所以默认关、profile 显式开。这是测出来的，不是设计出来的。

按语料特征分档（启动时判一次，不按查询切）：

| 档位 | 判定特征 | 向量 | 重排 |
|---|---|---|---|
| `wiki` | 平均标题 < 15 字 | 关 | 关 |
| `chat` | 原子/卡 ≤ 3 且正文均长 < 800 字 | 开 | 开 |
| `engineering` | 其余 | 开 | 关 |

---

## 用法

### 1. 准备 vault

任何 Markdown 目录都可以，只要每张卡片是一个 `.md` 文件。默认读 `~/.memory-vault`，用 `MEM_VAULT` 覆盖。

### 2. 建索引

```bash
npm install
npm run index
```

### 3. 接到 MCP 客户端

```json
{
  "mcpServers": {
    "memory_kb2": {
      "command": "node",
      "args": ["/absolute/path/to/memory-kb2/src/server.mjs"],
      "env": {
        "MEM_VAULT": "/absolute/path/to/your/vault"
      }
    }
  }
}
```

一个 MCP 进程只绑一个库。要在同一会话里切换多个库，就按库起多个实例。

### 4. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `MEM_VAULT` | `~/.memory-vault` | 知识库根目录 |
| `MEM_VECTOR` | 关闭 | 是否启用向量路 |
| `MEM_RERANK` | 按档位 | 是否启用重排 |
| `MEM_POOL` | 自适应 | 重排候选池深度 |
| `EMBED_API_MODEL` | 见代码 | 向量模型名 |
| `ALI_API_KEY` / `DASHSCOPE_API_KEY` | — | 向量与重排的 API 凭据 |

向量与重排走 OpenAI 兼容端点。不配凭据也能跑，只是没有语义召回和精排。

---

## 已知边界

- **需要 Node 22+**：索引依赖内建的 `node:sqlite`。
- **中文优先**：分词、停用词、标题权重都按中文卡片调过，英文库效果未测。
- **不是向量数据库**：卡片规模到万级时，全量向量加载会开始吃内存，届时需要外置向量库。
- **重排默认关**：在工程类短卡片上重排是负收益，个人博客/笔记类语料可能需要打开。

---

## 设计来源

RRF（Reciprocal Rank Fusion）来自 Cormack、Clarke、Büttcher 在 SIGIR 2009 提出的
排名融合方法，本项目的混合检索按这一思路实现。

依赖见 `package.json`，不在此列。

---

## 许可

MIT。
