# pi-llm-wiki × Obsidian 工作流优化计划

> 版本：2026-06-08（含审核修订）  
> 状态：P0-P4 ✅ | Obsidian 配置 ✅ | 插件 15 个全部就绪 | 三文档一致

---

## 零、审核发现（2026-06-08）

### 🔴 当前实现的盲区

| # | 盲区 | 风险 |
|---|------|------|
| G1 | **agent_end 无成功率监控** — `pi-llm-wiki.log` 只有 1 条记录，无法统计历史成/败 | 问题复发不会发现 |
| G2 | **obs_query 没用 Smart Connections** — Agent 搜知识库只用 REST API 关键词，语义搜索仅 Obsidian UI 可用 | Agent 搜索质量无提升 |
| G3 | **agent_end 每轮扫 vault 去重** — `alreadyInVault()` 遍历所有 raw/*.md，加 I/O | 每轮回复加延迟 |
| G4 | **schema 注入失败静默** — before_agent_start 失败只打 console.error | 整场对话缺 LLM-Wiki 规则 |
| G5 | **单轮对话也创建 raw** — "好的"/"继续" 产生无意义条目 | 噪音累积 |
| G6 | **startup recovery 与 agent_end 可能竞态** | 轻微浪费 |
| G7 | **obs_ingest 手动调用无去重** — 手动调两次 → 两个 raw | 重复数据 |
| G8 | **dlog 在 /tmp/ 重启丢失** | 崩溃后丢排障日志 |

### 🟡 计划中的问题

| # | 问题 |
|---|------|
| P-1 | **P4.1 知识升级检测过度设计** — "读取所有 wiki insights + 语义匹配" 无 embedding 可用时等于 grep |
| P-2 | **P4 优先级倒置** — P4.3 (Jaccard 重复检测) 远简单于 P4.1，应先做 |
| P-3 | **缺失：obs_compile 查重** — 编译前检查已有相同主题页面，比"事后 lint"更有价值 |
| P-4 | **缺失：管线失败恢复** — compile 成功但 weave 失败 → 永远卡在中间态 |
| P-5 | **缺失：slog 日志轮转** — `~/.pi/agent/pi-llm-wiki.log` 无限增长 |
| P-6 | **冗余：Heatmap Calendar / Juggl** — 纯美观，无工作流实质价值 |

### 调整后的优先级

```
先修盲区 G1-G8 → 再 P4.3 (重复检测) → P4.2 (矛盾检测) → P4.1 延后
+ 新增: obs_compile 查重、管线失败恢复、slog 轮转
- 移除: Heatmap Calendar、Juggl
```

---

## 一、当前状态总览

### 1.1 pi-llm-wiki 扩展（TypeScript，21 个源文件）

| 组件 | 文件 | 状态 |
|------|------|:--:|
| 入口 | `index.ts` (7 tools + 3 hooks + system refresh) | ✅ |
| 配置 | `config.ts`, `client.ts`, `project.ts`, `manifest.ts` | ✅ |
| Hooks | `before-start.ts` (schema 注入), `agent-end.ts` (自动摄入 + 双重去重), `startup-recovery.ts` (崩溃恢复) | ✅ |
| 写入 | `ingest.ts` (REST API + fs 双写降级 + 文件名防碰撞) | ✅ |
| 搜索 | `query.ts` (图谱 → REST API 三级深度) | ✅ |
| 编译 | `compile.ts` (raw → wiki + 双链) | ✅ |
| 织入 | `weave.ts` (回链 + 图谱自动更新) | ✅ |
| 检查 | `lint.ts` (孤立/过期/断链) | ✅ |
| 回流 | `capture.ts` | ✅ |
| 引用 | `reference.ts` (跨库卡片) | ✅ |
| 监控 | `system/dashboard.ts`, `system/audit.ts`, `system/tracker.ts`, `system/refresh.ts` | ✅ |
| 日志 | dlog (`/tmp/`) + slog (JSON → `~/.pi/agent/pi-llm-wiki.log`) | ✅ |

### 1.2 Obsidian Vault 配置

| 类别 | 配置 | 状态 |
|------|------|:--:|
| 核心插件 | 17/24 启用（graph/backlink/outline/properties 等全开） | ✅ |
| REST API | 端口 27126 HTTP，API key → `.gitignore` 排除 | ✅ |
| Git 备份 | Obsidian Git：5min 提交 / 15min 推送 / 30min 拉取 | ✅ |
| 搜索 | Smart Connections 语义搜索 (SiliconFlow BGE) + Omnisearch BM25 | ✅ |
| 模板 | Templater：6 个文件夹模板自动映射 | ✅ |
| 格式化 | Linter：lintOnSave + frontmatter 自动排序 | ✅ |
| 归类 | Auto Note Mover：标签规则自动移页 | ✅ |
| 可视化 | Dataview 索引 + Kanban 管线 + Floating TOC + Tasks checkbox | ✅ |
| 导航 | Strange New Worlds (引用计数) + Cmdr (命令面板) | ✅ |
| 工具 | Note Refactor (页面拆分) + Tag Wrangler (标签管理) | ✅ |
| 安全 | `.gitignore` 排除 REST API data.json | ✅ |

### 1.3 完整数据流

```
┌─ 写入路径 ──────────────────────────────────────────┐
│                                                      │
│  Pi 会话 → agent_end (auto)                          │
│          → OM 可用? → buildAutoSummary                │
│          → OM 不可用? → buildFallbackSummary           │
│          → ingest() → REST API → fs fallback          │
│          → raw/sessions/<project>/YYYY-MM-DD-*.md     │
│                                                      │
│  手动 → obs_compile → wiki/<category>/*.md            │
│       → obs_weave   → 更新已有页面 + 图谱             │
│       → obs_lint    → 健康报告                        │
│                                                      │
│  启动 → startup_recovery → 扫描孤儿 .jsonl             │
│       → before_agent_start → 刷新 system/ 三页面       │
│                                                      │
└──────────────────────────────────────────────────────┘
                         ↕
┌─ 读取路径 ──────────────────────────────────────────┐
│                                                      │
│  Pi Agent 调用 obs_query("...")                       │
│       → 图谱.md 扫描 (cheapest)                       │
│       → REST API 全文搜索                             │
│       → depth: brief/normal/full                     │
│                                                      │
│  Obsidian 内浏览：                                    │
│       → 仪表盘 / 流程巡检 / 问题追踪                   │
│       → Dataview 自动索引                              │
│       → Kanban 管线看板                                │
│       → Graph View 知识网络                            │
│       → Smart Connections 语义关联                     │
│       → Omnisearch BM25 全文搜索                       │
│                                                      │
└──────────────────────────────────────────────────────┘
```

---

## 二、下一步：盲区修复（G1-G8）

| # | 任务 | 改动 | 难度 |
|---|------|------|:--:|
| G1 | **agent_end 成功率监控** | dashboard 增加 agent_end 成功/失败计数，读 `pi-llm-wiki.log` | 低 |
| G2 | **obs_query 接入 Smart Connections** | 搜索时判断 Obsidian 是否运行，若在则调用 Smart Connections API | 中 |
| G3 | **agent_end 去重优化** | 用内存 cache 替代每次遍历 vault 文件系统 | 低 |
| G4 | **schema 注入失败告警** | 失败时写入 slog 并返回 warning event，让 Agent 感知 | 低 |
| G5 | **最短会话过滤** | agent_end: 用户消息 ≤1 条且总 content < 200 字符 → 跳过 | 低 |
| G7 | **obs_ingest 去重** | ingest 时检查 vault 中是否已有同 session_id 的 raw | 低 |
| G8 | **dlog 持久化** | 改为 `~/.pi/agent/pi-llm-wiki-debug.log`，重启不丢失 | 低 |
| P-5 | **slog 轮转** | 超过 1MB 时 rotate 到 `.log.1`，保留最近 3 个 | 低 |

## 三、待实施：知识质量增强

### 3.1 obs_compile 编译前查重（新增，建议先做）

**目标**：编译前搜索 wiki/ 中是否已有相同主题页面，若有则建议 weave 到已有页面而非创建新页面。

**优于 P4.3 的理由**：事前预防 > 事后检测。

**文件**：`src/tools/compile.ts`

### 3.2 P4.3 obs_lint 重复内容检测

**目标**：对 wiki 页面两两计算 Jaccard 相似度（`[[wikilinks]]` + 关键词），>0.7 → 标记。

**文件**：`src/tools/lint.ts`

### 3.3 P4.2 obs_lint 矛盾检测

**目标**：同主题多版本 → 标记 `⚠️ 需决策`

**文件**：`src/tools/lint.ts`

### 3.4 管线失败恢复（新增）

**目标**：compile 成功但 weave 失败的 session → obs_lint 检测并标记为"半成品"。

**文件**：`src/tools/lint.ts`

### 3.5 P4.1 知识升级检测（延后）

> ⚠️ 当前规模下不实用——无 embedding 模型可用时退化为 grep。等 wiki 页面 >100 或有了本地 embedding 后再做。

---

## 三、可选增强（锦上添花）

### 3.1 Obsidian 插件

> ⚠️ Heatmap Calendar / Juggl 已从计划移除——纯美观，对工作流无实质加速。
> 当前 15 个插件足够覆盖全链路。

### 3.2 pi-llm-wiki 代码质量

| # | 任务 | 说明 | 优先级 |
|---|------|------|:--:|
| C1 | 端到端测试脚本 | 自动运行 ingest → compile → weave → lint 验证全链路 | 🟡 |
| C2 | ingest 重试机制 | REST API 写入失败时重试 2 次再 fallback 到 fs | 🟢 |
| C3 | agent_end 合并去重 | 当前每轮触发，同一 session 多次触发时合并内容 | 🟢 |

### 3.3 工作流优化

| # | 任务 | 说明 | 优先级 |
|---|------|------|:--:|
| W1 | 编译提醒自动化 | 待编译 ≥5 时，before_agent_start 注入提醒到 system prompt | 🟡 |
| W2 | 周报自动生成 | 每周汇总编译率、健康评分变化、新增页面数 | 🟢 |

---

## 四、文件清单

```
pi-llm-wiki/
├── src/                    ← 21 个 .ts 文件 ✅
│   ├── index.ts
│   ├── config.ts, client.ts, manifest.ts, project.ts
│   ├── hooks/ (3)
│   ├── tools/ (7)
│   └── system/ (4)
├── ROADMAP.md              ← 开发计划 ✅
└── OPTIMIZATION_PLAN.md    ← 本文件 ✅

LLM-Wiki Vault/
├── raw/sessions/           ← 自动写入 ✅
├── wiki/                   ← 编译产出 ✅
│   ├── 仪表盘/流程巡检/问题追踪 ← 系统页面 (自动刷新)
│   ├── 管线看板.md         ← Kanban ✅
│   └── 索引/              ← Dataview 聚合 ✅
├── templates/              ← 7 个模板 ✅
├── .obsidian/              ← 15 个插件 + 配置 ✅
└── .gitignore              ← API key 已排除 ✅
```

---

## 五、验收检查清单

| 检查项 | 方法 | 频率 |
|--------|------|------|
| agent_end 是否产生空壳？ | `cat /tmp/pi-llm-wiki-debug.log` | 每次会话 |
| 崩溃恢复是否工作？ | 重启 Pi，检查 raw/sessions/ 是否有 crash-recovery 文件 | 按需 |
| 监控页面是否刷新？ | 打开 Obsidian 看仪表盘/流程巡检/问题追踪 | 每次会话 |
| 编译率是否下降？ | 检查仪表盘健康评分 | 每周 |
| 孤立节点是否增加？ | `obs_lint` | 每周 |
| Git 是否正常推送？ | Obsidian Git status bar | 每天 |
| TypeScript 编译 | `npx tsc --noEmit` | 每次修改 |
