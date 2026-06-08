# pi-llm-wiki × Obsidian 工作流优化计划

> 版本：2026-06-08  
> 状态：P0-P3 ✅ | P4 ⬜ | Obsidian 配置 ✅ | 插件 15 个全部就绪

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

## 二、待实施：P4 知识进化

### P4.1 obs_compile 知识升级检测

**目标**：同一洞察在 2+ 项目中出现 → 编译目标从 `wiki/项目/` 升级为 `wiki/发现/` 或 `wiki/概念/`

**实现思路**：
- compile 时读取所有已有 wiki 页面的 insights
- 关键词/语义匹配检测重复洞察
- 若匹配 → 升级编译目标 + 标注 "已验证 N 次"

**文件**：`src/tools/compile.ts`

**优先级**：🟡 中 — 长期提升 wiki 质量

### P4.2 obs_lint 矛盾检测

**目标**：同一主题出现多个互相矛盾的 wiki 页面 → 标记 `⚠️ 需决策`

**实现思路**：
- 分组 wiki 页面（同 tags 或同 project）
- 关键词检测对立表述（"推荐 A" vs "使用 B"）
- 标记但不自动合并——留给人类决策

**文件**：`src/tools/lint.ts`

**优先级**：🟡 中

### P4.3 obs_lint 重复内容检测

**目标**：检测内容高度重复的页面 → 建议合并或重定向

**实现思路**：
- 对 wiki 页面两两计算 Jaccard 相似度（基于 `[[wikilinks]]` 和关键词）
- 相似度 > 0.7 → 标记 "可能重复"

**文件**：`src/tools/lint.ts`

**优先级**：🟢 低 — 当前页面数量还不大

---

## 三、可选增强（锦上添花）

### 3.1 Obsidian 插件

| # | 插件 | 用途 | 优先级 |
|---|------|------|:--:|
| O1 | **Heatmap Calendar** | 日历热力图显示 session 创建密度 | 🟢 |
| O2 | **Juggl** | 高级图谱分析（聚类/中心度/路径） | 🟢 |

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
