# pi-llm-wiki 开发计划书

> 版本：`v1.3.0-dev`（P0 ✅ P1 ✅，P2 健壮性增强进行中）  
> 位置：`~/projects/.dotfiles/modules/pi-llm-wiki/`（dotfiles submodule）  
> 依赖：Obsidian Local REST API (`localhost:27126`) + `pi-observational-memory`

---

## 一、当前版本确认（v1.1.0-dev）

### 安装验证

| 检查项 | 状态 |
|--------|------|
| 全局注册 (`~/.pi/agent/settings.json`) | ✅ `"../../pi-llm-wiki"` |
| `package.json` 符合 Pi 规范 (`pi.extensions`) | ✅ |
| TypeScript strict 编译 | ✅ 零错误 |
| 15 个源文件完整 | ✅ |
| Git 版本管理 | ✅ |
| 写可靠性（REST API 降级） | ❌ 未实现 | 见 P0.0 |
| 系统监控页面自动生成 | ❌ 未迁移 | 见 P0 |

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

### 3 Hooks 工作正常

| Hook | 验证 | 备注 |
|------|------|------|
| `before_agent_start` | ✅ | schema.md 注入 system prompt，5min 缓存，API 不可用时读文件系统 |
| `agent_end` | ✅ | `getBranch()` API 读 OM observations + fallback 原始用户消息提取 + dlog 调试日志 |
| `startup_recovery` | ✅ | 启动时扫描孤儿 session（崩溃/强杀），直接写 vault 文件系统补入 |

### 已修复的关键问题

| 问题 | 修复 | 日期 |
|------|------|------|
| API key 硬编码 | 环境变量 `OBSIDIAN_LLM_WIKI_KEY` | 迁移前 |
| `detectProject` 只取 basename | 读 AGENTS.md `#` 标题 | 迁移前 |
| `agent_end` 空壳 | markIngested 去重 + OM 集成 | 迁移前 |
| `agent_end` 完全不触发 | `getEntries()` → `getBranch()`，与 OM API 对齐 | 2026-06-06 |
| `agent_end` OM 数据为空时跳过 | fallback 原始用户消息提取 | 2026-06-06 |
| 崩溃/强杀后 session 丢失 | `startup-recovery.ts` 启动扫描孤儿 session | 2026-06-06 |
| ingest 同名标题覆盖 | 文件名加 HHmmss 后缀 | 2026-06-06 |
| 调试不可观测 | dlog → `/tmp/pi-llm-wiki-debug.log` | 2026-06-06 |

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

> 优先级重新评估（2026-06-06）：agent_end 故障和 REST API 单点依赖是最紧急问题，
> 监控系统次之——能告知问题但不能修复问题。

### P0 — 写可靠性 ✅

| # | 任务 | 产出 | 状态 |
|---|------|------|------|
| P0.0 | `ingest.ts` 写文件系统降级 | REST API 不可用时 `fs.writeFileSync` 直接写 vault | ✅ |

### P1 — 监控系统迁移 ✅

| # | 任务 | 产出 | 状态 |
|---|------|------|------|
| P1.1 | `src/system/dashboard.ts` — 仪表盘生成器 | 编译率、健康评分、项目分布、最近操作 | ✅ |
| P1.2 | `src/system/audit.ts` — 流程巡检生成器 | 5 阶段检查（C1-C5）、警报分级 | ✅ |
| P1.3 | `src/system/tracker.ts` — 问题追踪生成器 | 待编译队列、最近完成 | ✅ |
| P1.4 | `src/system/refresh.ts` — before_agent_start 刷新 | 每次会话启动自动刷新三个页面 | ✅ |
| P1.5 | 环境变量已设置 (`OBSIDIAN_LLM_WIKI_KEY`) | | ✅ |

### P2 — 工作流闭环（3/4 完成）

| # | 任务 | 对应 schema 规则 | 状态 |
|---|------|-----------------|------|
| P2.1 | `obs_weave` 自动更新 `wiki/图谱.md` | 规则 6 | ✅ |
| P2.2 | `obs_compile` 显示提取的 insights 数量和内容 | 规则 3.5 | ✅ |
| P2.3 | `obs_lint` 自动标记 stale（`fix=true`） | 规则 5 | ✅ |
| P2.4 | `obs_query` 深度控制（brief/normal/full） | §8 | ⚠️ 参数接受但未生效，需实现 |

### P3 — 健壮性增强

| # | 任务 | 说明 |
|---|------|------|
| P3.1 | agent_end 去重增强 | 当天同一 session 已摄入则跳过（不仅是 markIngested 标记） |
| P3.2 | startup recovery 增量优化 | 用 marker 文件替代时间戳，避免重复扫描 |
| P3.3 | 调试日志结构化 | dlog 从 `/tmp/` 临时文件升级到标准化日志 |

### P4 — 知识进化

| # | 任务 | 对应 schema 规则 |
|---|------|-----------------|
| P4.1 | `obs_compile` 知识升级检测（2+ 项目 → 全局） | §7.2 |
| P4.2 | `obs_lint` 矛盾检测（同一主题多版本） | §7.2 |
| P4.3 | `obs_lint` 重复内容检测 | §7.2 |

### P5 — 长期维护

| # | 任务 |
|---|------|
| P5.1 | 新工具 `obs_aggregate`：季度精华 → `wiki/记忆/YYYY/Qn.md` |
| P5.2 | 新工具 `obs_distill`：读经验日志 → 重写摘要 → 清空 |
| P5.3 | 自动化测试套件（验收标准来自 §五） |

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
    ├── index.ts          # 入口：注册 7 tools + 3 hooks
    ├── config.ts         # Vault 路径、API key、阈值
    ├── client.ts         # Obsidian REST API 封装
    ├── manifest.ts       # 编译/织入/linted 状态追踪
    ├── project.ts        # 项目检测（AGENTS.md 标题）
    ├── hooks/
    │   ├── before-start.ts       # schema.md 注入 system prompt
    │   ├── agent-end.ts          # OM 集成 + fallback 原始消息 + dlog
    │   └── startup-recovery.ts   # 启动孤儿 session 扫描恢复
    ├── tools/
    │   ├── ingest.ts     # obs_ingest
    │   ├── query.ts      # obs_query
    │   ├── compile.ts    # obs_compile
    │   ├── weave.ts      # obs_weave
    │   ├── lint.ts       # obs_lint
    │   ├── capture.ts    # obs_capture
    │   └── reference.ts  # obs_reference
    └── system/           # ⏳ P1 — 监控页面生成（待实现）
        ├── dashboard.ts  # 仪表盘生成器
        ├── audit.ts      # 流程巡检生成器
        └── tracker.ts    # 问题追踪生成器
```

---

## 七、环境变量

```bash
# 推荐加到 ~/.bashrc
export OBSIDIAN_LLM_WIKI_KEY="your-obsidian-rest-api-key"
```
