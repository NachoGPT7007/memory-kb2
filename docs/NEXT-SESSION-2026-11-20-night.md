# 交接 2026-11-20 晚：检索到顶 + 记忆插件跑通

> 给新会话的自包含交接。本文所有数字为写稿时实测，标注「未验证」的项请勿当成已完成。

## 0. 一句话状态

**检索层已到顶**（工程库 top1 93.2% / top3 100%；CodeRAG 打平论文 BM25 基线），
**记忆插件已跑通并从零开始自动沉淀**（17 张 pending 卡在库），
**剩余两项沉淀条件的代码已写但从未触发验证**。

## 1. 当前事实（实测）

| 项 | 值 |
|---|---|
| 仓库 | `~/memory-kb2`，HEAD `a3ab82c`，工作区干净，已同步 origin/main |
| npm | `memory-kb2@0.4.3`（latest），`npm i -g memory-kb2` 可用 |
| 索引 | 496 卡 / 5184 原子，`built_at` 2026-11-20T08:38:59Z |
| 待审卡 | **17 张 pending**（`memory_stats` 可查，或 `grep -rl "^status: pending"`） |
| 插件 | `~/dsh-armory/packages/dsh-memory-kb2`（已装配到 `profiles/web`） |
| 账本 | `~/.dsh-web-lab/memory-recall-ledger.jsonl`（search + get 两类记录） |
| 装配备份 | `profiles/web/{package.json,cordis.patch.yml}.bak-20261120-pre-memory-kb2` |

## 2. 本会话做成了什么

### 2.1 CodeRAG 定位到顶（十二组单变量实验）

nDCG@10 从 **87.5 → 93.2**，与论文 Table 3 的 BM25 基线持平。

**根因**（不是算法，是切分）：`src/index.mjs` 的 `build()` 正文入库只认「回答型小节」
（排障/要点/结论…），代码文件没有 Markdown 标题 → 全部落进兜底 `bodyRaw.split(/\n\s*\n/)`
→ **一个 function 平均切成 11.6 个原子**。原子级 BM25 造成三重偏差：长度归一化基准是段落
不是函数、tf 不跨段累加、idf 的 N 从文档数变成原子数（放大 11.6 倍）。

**修复**：`kind: code` 的卡整卡入库（`MEM_BODY_WHOLE=1` 强制开关保留）。

**已排除**（别再试）：拆标识符 −4.8、覆盖率因子关 +1.1、整窗 +0.5、空白分词 +1.4、
逻辑回归校准（AUC 已 0.9897，无空间）。

**数据已丢**：`/tmp` 被系统清理，数据集与十二组 JSON 都没了；重跑需下载
`github.com/code-rag-bench/code-rag-bench`。

### 2.2 记忆插件跑通（从 0 开始积累）

**根因**：插件监听 `agent/turn-stopping`，但该事件由 `agentEvents.serial(carrier, ...)` 派发，
`carrier = agentCarrier(agent)` 带 `Context.filter`；cordis 的 `_resolve` 用它过滤监听器，
**根 ctx 注册的 listener 永远收不到**。DSH 升级后静默失效了 10 天。

**修复**：改监听无 carrier 的 `session/event` + `turn/end`（宿主 `dsh-goal` 也用这条）。

### 2.3 MCP 工具补齐（分步检索链）

| 工具 | 作用 |
|---|---|
| `memory_map` | 按目录列出卡标题/路径/日期，带字符预算（模仿 aider 的 repo map） |
| `memory_get` | 按 path 读整卡，带路径穿越防护 |
| `memory_search` | 已组装化：每卡返回「路径 + 更新日期 + 状态 + 结论段」，末尾给同目录邻居（**带 path**） |
| 弱匹配提示 | query 向量与全库原子的最大余弦 < 0.60 时提示「库里可能没有相关内容」 |
| 反馈进排序 | `get` 记账 → 检索时 ×(1 + 0.03·ln(1+n))，只影响近分卡 |

### 2.4 索引同步链路修复（三个叠加的静默失败）

1. `SYNC_SCRIPT` 指向不存在的 `~/memory-kb2/vendor/embed/sync-index.mjs`
2. 同步脚本调 `dsh-armory` 的旧索引器（无 `scope` 列）→ **scope 过滤一直静默降级**
3. 短路只认卡片 mtime，卡没变但向量缺失时永远跳过

修完：sync 脚本收进本仓库、改用本地索引器、短路加向量检查，`scope` 列恢复。

### 2.5 发布与隐私

- npm 发布 `0.4.3`（`0.0.0-stage` 是创建 token 时 npm 自动生成的占位包，删不掉但无害）
- 全历史移除私人评测数据（`eval/`、`bench/cases-engineering.json`）与 `.archify/`
- 全部本机绝对路径脱敏为 `~`
- commit message 重写（去掉「怎么错的」这类自揭内容）

## 3. 关键教训（已沉淀成卡）

1. **公开仓库的 commit message 只写「做了什么」**，不写怎么错的、原来错在哪、验证过程的反复
2. **示例数据必须虚构**：一个脱敏工具的 README 用真实当事人姓名当示例，这是本次最严重的发现
3. 「反正是公开的」「反正只是示例」——这两个念头就是泄露的起点
4. **已安装 ≠ 已装配**：scope 列缺失、bin 字段被 npm 静默删除，都是「功能上线了但那根线没接上」

## 4. 待办（按优先级）

### 4.1 未验证（代码已写，从未触发过）

**按任务 debounce + 一次 0–3 张**（`~/dsh-armory/packages/dsh-memory-kb2`）：

- `scheduleCapture` 改为累积事件 + 空闲计时器（`captureIdleMs` 默认 5 分钟）
- 提示词改为输出 `{"cards": [...]}`，最多 3 张，同主题合并不拆碎
- `parseCaptureJson` 支持数组，兼容旧单卡格式（已单测：截断/兼容/过滤均正确）
- **风险**：改动后没有真实会话触发过，不知道 debounce 是否真在工作

验证方法：改完后观察一次会话结束后 5 分钟，vault 是否新增 0–3 张卡；或临时把
`captureIdleMs` 调成 30000（配置下限 30 秒）快速验证。

### 4.2 需要人做的

- **17 张 pending 卡待审批**（`auditMode` 保持 `all`，用户决定手动批）
- **README 待重写**（用户计划用 Kimi K3；注意 `bench/` 缺数据文件，别提复现）

### 4.3 可做但不急

- 反馈闭环的数据积累（账本里 get 记录还很少，加成几乎是摆设）
- 弱匹配阈值的跨库迁移（法学库 941 卡的 cos 分布与工程库不同，硬阈值 0.60 可能不适用；
  真要做函数化，用 64 条题交叉构造负例 ≈ 4032 对）

## 5. 验证命令

```bash
# 检索是否正常
cd ~/memory-kb2 && node bin/memory-kb2.mjs stats

# 索引是否落后
cat ~/.dsh-web-lab/memory-vault/.index/.last-sync

# 插件是否加载（新会话看系统提示里有没有「记忆核心」段）

# 弱匹配是否生效（应提示）
#   memory_search("zzz不存在的查询xyz")

# 索引同步是否通
MEM_VAULT=~/.dsh-web-lab/memory-vault node ~/memory-kb2/vendor/embed/sync-index.mjs --check
```

## 6. 回滚

```bash
# 代码
cd ~/memory-kb2 && git revert <commit>   # 或 git reset --hard a3ab82c

# 插件装配
cp ~/.dsh-web-lab/profiles/web/package.json.bak-20261120-pre-memory-kb2 \
   ~/.dsh-web-lab/profiles/web/package.json
cp ~/.dsh-web-lab/profiles/web/cordis.patch.yml.bak-20261120-pre-memory-kb2 \
   ~/.dsh-web-lab/profiles/web/cordis.patch.yml
systemctl --user restart dsh-lab-web

# 插件代码
cd ~/dsh-armory/packages/dsh-memory-kb2 && git checkout -- .
```

## 7. 一句话提醒

这个项目**没有可复现的公开优势**。真实价值是三件：一个每天能用的个人检索工具（93.2/100）、
一份稀缺的证伪记录（20 轮实验、5 次「组件没用」、4 次观测错误）、卡片生命周期语义。
**不要**在任何公开榜上宣称排名。
