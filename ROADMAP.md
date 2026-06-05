# pi-llm-wiki 开发计划书

> 版本：`v1.0.0` → `v1.1.0-dev`（Phase 1 ✅，监控迁移待做）  
> 安装：`~/pi-llm-wiki/`，全局 local package，`pi install` 注册  
> 依赖：Obsidian Local REST API (`localhost:27126`) + `pi-observational-memory`

---

## 一、当前版本确认（v1.1.0-dev）

### 安装验证

| 检查项 | 状态 |
|--------|------|
| 全局注册 (`~/.pi/agent/settings.json`) | ✅ `"../../pi-llm-wiki"` |
| `package.json` 符合 Pi 规范 (`pi.extensions`) | ✅ |
| TypeScript strict 编译 | ✅ 零错误 |
| 14 个源文件完整 | ✅ |
| Git 版本管理 (9 commits) | ✅ |
| 系统监控页面自动生成 | ❌ 未迁移 | 见 §三 |

### 7 工具全部可用

| 工具 | 验证 | 备注 |
|------|------|------|
| `obs_ingest` | ✅ | 格式正确：title/project/session_id/compiled 全字段 |
| `obs_query` | ✅ | 全文搜索 + frontmatter 富化 |
| `obs_compile` | ✅ | raw → wiki + 双链 + markCompiled |
| `obs_weave` | ✅ | 回链 + 经验日志追加 |
| `obs_lint` | ✅ | 孤立/过期/断裂链接检测 |
| `obs_capture` | ✅ | 洞察回流 |
| `obs_reference` | ✅ | 跨库引用卡片 |

### 2 Hooks 工作正常

| Hook | 验证 | 备注 |
|------|------|------|
| `before_agent_start` | ✅ | schema.md 注入 system prompt，5min 缓存 |
| `agent_end` | ✅ | 去重（markIngested）+ 读取 observational-memory 生成有内容复盘 |

### 已修复的关键问题（本次会话）

| 问题 | 修复 | Commit |
|------|------|--------|
| API key 硬编码 | 环境变量 `OBSIDIAN_LLM_WIKI_KEY` + 单次警告 | `1832d42` |
| `detectProject` 只取 basename (pi vs Pi-Agent) | 读 AGENTS.md `#` 标题 | `a23e110` |
| `agent_end` 每次创建空壳 | markIngested 去重 | `8d12438` |
| `agent_end` 无内容空壳 | 集成 pi-observational-memory 提取 observations | `c18f7be` |
| `package.json` 非规范字段 | `pi.extensions` 替代自定义字段 | `fd35dd7` |
| 断链检测死逻辑 (lint.ts) | 修复匹配逻辑 | 审计修复 |
| YAML frontmatter 转义缺失 | `quoteYaml()` 函数 | 审计修复 |
| 多处未使用导入 | 清理 | 审计修复 |

---

## 二、与 pi-observational-memory 的协作

```
pi-observational-memory              pi-llm-wiki
─────────────────────────           ──────────────────────
compaction → observations      →    agent_end 读取 observations
           → reflections       →    生成有内容的自动复盘
                               
recall tool                     →    obs_ingest (LLM 手动调用)
                                →    obs_compile (≥5 raw)
                                →    obs_weave → obs_lint
```

**关键**：两个扩展通过 session entries 协作——observational-memory 写入 `om.observations.recorded`，agent-end 读取这些条目生成复盘。不会再有空壳。

---

## 三、⚠️ 已知断层：监控系统未迁移

> **这是当前最大的功能缺口。**

旧 `obsidian-knowledge.ts`（195KB 单文件）负责两件事：
1. 7 个知识管理工具 + 2 个 hook
2. 3 个系统监控页面的自动生成

重写为 pi-llm-wiki 时，只迁移了第 1 部分（工具+hook），第 2 部分（监控页面生成）**未迁移**。

### 三个监控页面的状态

| 页面 | 旧代码实现 | 新 package 状态 | 当前实际 |
|------|----------|---------------|---------|
| `wiki/仪表盘.md` | `generateDashboard()` | ❌ 未迁移 | 显示过时数据（旧代码最后一次生成的结果） |
| `wiki/流程巡检.md` | `generateFlowAudit()` | ❌ 未迁移 | 空壳——只显示"五阶段管线全通"，无数据支撑 |
| `wiki/问题追踪.md` | `generateIssueTracker()` | ❌ 未迁移 | 过时数据 + 混入了非管线内容 |

### 为什么这是 P0 而非 P3

- 没有监控页面 = 人对系统**完全失明**
- 编译率下降、空壳率回升、幽灵条目重现——都不会被发现
- 仪表盘原来每 15 分钟自动刷新，现在停在最后一次旧代码生成的状态
- 这是生产系统的基础设施，不是"锦上添花"

### 迁移需要的能力

新 package 已有以下数据源，可以直接复用：

| 数据 | 来源 | 可生成 |
|------|------|--------|
| 编译率、织入率 | `manifest.ts` → `getUncompiledSessions()` | 仪表盘统计 |
| 待编译列表 | `manifest.ts` → frontmatter scan | 问题追踪 |
| 孤立/过期/断链 | `lint.ts` → `lint()` | 流程巡检 C4 |
| ingest 时间线 | `log.md` → grep `^## \[` | 仪表盘最近操作 |
| 项目分布 | `raw/sessions/` 目录结构 | 仪表盘项目统计 |
| 空壳检测 | frontmatter scan (`auto_generated: "true"`) | 流程巡检 C1 |
| 图谱覆盖率 | `wiki/图谱.md` wikilink 解析 vs wiki/ 文件列表 | 流程巡检 |
| 健康评分 | 加权公式（已在 工作流监控与改进.md 定义） | 仪表盘 |

需要新建：`src/system/` 目录，包含 `dashboard.ts`, `audit.ts`, `tracker.ts` 三个生成器。

### 过渡方案（迁移完成前）

| 监控需求 | 临时替代 |
|---------|---------|
| 知道有多少待编译 | 每次启动后跑 `obs_lint`，或看 `问题追踪.md`（过时但仍有参考）|
| 知道 wiki 是否健康 | 手动跑 `obs_lint` |
| 完整管线健康 | 无替代——这是迁移的根本原因 |

---

## 四、优先级排序的改进计划

### P0 — 监控系统迁移（本阶段）

| # | 任务 | 产出 |
|---|------|------|
| P0.1 | `src/system/dashboard.ts` — 仪表盘生成器 | `wiki/仪表盘.md` 自动刷新：编译率、健康评分、项目分布、最近操作 |
| P0.2 | `src/system/audit.ts` — 流程巡检生成器 | `wiki/流程巡检.md` 自动刷新：5 阶段检查（C1-C5）、环比退化、警报分级 |
| P0.3 | `src/system/tracker.ts` — 问题追踪生成器 | `wiki/问题追踪.md` 自动刷新：待编译队列、最近关闭、只追踪管线 |
| P0.4 | 注册到 `before_agent_start` hook | 每次会话启动自动刷新三个页面 |
| P0.5 | 环境变量已设置 (`OBSIDIAN_LLM_WIKI_KEY`) | ✅ 已完成 — `~/.profile` + `~/.bashrc` |

### P1 — 工作流闭环（✅ 已完成 — commit `4121112`）

| # | 任务 | 对应 schema 规则 | 状态 |
|---|------|-----------------|------|
| P1.1 | `obs_weave` 自动更新 `wiki/图谱.md` | 规则 6 | ✅ 已实现 |
| P1.2 | `obs_compile` 显示提取的 insights 数量和内容 | 规则 3.5 (编译前确认) | ✅ 已实现 |
| P1.3 | `obs_lint` 自动标记 stale（`fix=true` 更新 frontmatter） | 规则 5 | ✅ 已实现 |
| P1.4 | `obs_query` 多级检索：图谱 → REST API | §8 | ✅ 已实现 |

### P2 — 知识进化（两周内）

| # | 任务 | 对应 schema 规则 |
|---|------|-----------------|
| P2.1 | `obs_compile` 知识升级检测（2+ 项目 → 全局） | §7.2 |
| P2.2 | `obs_lint` 矛盾检测（同一主题多版本） | §7.2 |
| P2.3 | `obs_lint` 重复内容检测 | §7.2 |
| P2.4 | `obs_query` 深度控制实现（brief/normal/full） | §8 | ✅ 已实现（参数已添加） |

### P3 — 长期维护（月度）

| # | 任务 |
|---|------|
| P3.1 | 新工具 `obs_aggregate`：季度精华 → `wiki/记忆/YYYY/Qn.md` |
| P3.2 | 新工具 `obs_distill`：读经验日志 → 重写摘要 → 清空 |
| P3.3 | REST API 不可用时的文件系统直写降级 |

---

## 五、测试与验证策略

| 频率 | 测试 | 验收标准 |
|------|------|----------|
| **每次会话** | agent_end 是否产生空壳？ | 0 空壳 |
| **每次会话** | obs_ingest 格式是否完整？ | title/project/session_id/compiled 全字段 |
| **每周** | 未编译 raw ≥5 时触发 compile → weave → lint | 全链无错误 |
| **每周** | lint 报告 0 error | error=0, warning 递减 |
| **每月** | 图谱.md 是否最新 | 含本月所有新页面 |
| **按需** | tsc strict 编译 | 零错误 |

---

## 六、目录结构

```
~/pi-llm-wiki/
├── package.json          # Pi package manifest (pi.extensions)
├── ROADMAP.md            # 本文件
├── .gitignore
└── src/
    ├── index.ts          # 入口：注册 7 tools + 2 hooks
    ├── config.ts         # Vault 路径、API key、阈值
    ├── client.ts         # Obsidian REST API 封装
    ├── manifest.ts       # 编译/织入/linted 状态追踪
    ├── project.ts        # 项目检测（AGENTS.md 标题）
    ├── hooks/
    │   ├── before-start.ts   # schema.md 注入 system prompt
    │   └── agent-end.ts      # 智能兜底 + observational-memory 集成
    ├── tools/
    │   ├── ingest.ts     # obs_ingest
    │   ├── query.ts      # obs_query
    │   ├── compile.ts    # obs_compile
    │   ├── weave.ts      # obs_weave
    │   ├── lint.ts       # obs_lint
    │   ├── capture.ts    # obs_capture
    │   └── reference.ts  # obs_reference
    └── system/           # ⏳ P0 — 监控页面生成（待实现）
        ├── dashboard.ts  # 仪表盘生成器
        ├── audit.ts      # 流程巡检生成器
        └── tracker.ts    # 问题追踪生成器
```

---

## 七、环境变量

```bash
# 推荐加到 ~/.bashrc
export OBSIDIAN_LLM_WIKI_KEY="5b484f2a70fb254383feaed8fe92604841f5fd2eda221e1fa8ec0e50839b1a9e"
```
