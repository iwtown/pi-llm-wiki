# pi-llm-wiki 开发计划书

> 版本：`v1.5.0`（P0-P4 ✅，P5 长期维护待实施）  
> 详细优化计划见 `OPTIMIZATION_PLAN.md`
> 位置：`~/projects/.dotfiles/modules/pi-llm-wiki/`（dotfiles submodule）  
> 依赖：Obsidian Local REST API (`localhost:27126`) + `pi-observational-memory`

---

## 一、当前版本确认（v1.4.0）

### 安装验证

| 检查项 | 状态 |
|--------|------|
| 全局注册 (`~/.pi/agent/settings.json`) | ✅ `"../../pi-llm-wiki"` |
| `package.json` 符合 Pi 规范 (`pi.extensions`) | ✅ |
| TypeScript strict 编译 | ✅ 零错误 |
| 19 个源文件完整 | ✅ |
| Git 版本管理 | ✅ |
| 写可靠性（REST API 降级 + fs） | ✅ |
| 系统监控页面自动生成 | ✅ |

### 7 工具 + 3 Hooks 全部可用

| 工具 | 验证 | 备注 |
|------|------|------|
| `obs_ingest` | ✅ | 格式正确：title/project/session_id/compiled 全字段，REST API 故障时降级文件系统 |
| `obs_query` | ✅ | 全文搜索 + frontmatter 富化 + depth 三级检索 |
| `obs_compile` | ✅ | raw → wiki + 双链 + markCompiled + 知识升级检测 |
| `obs_weave` | ✅ | 回链 + 经验日志追加 + 图谱自动更新 |
| `obs_lint` | ✅ | 孤立/过期/断裂 + 矛盾/重复检测 |
| `obs_capture` | ✅ | 洞察回流 |
| `obs_reference` | ✅ | 跨库引用卡片 |
| `obs_aggregate` | ✅ | 季度精华聚合 → wiki/记忆/YYYY/Qn.md |
| `obs_distill` | ✅ | 经验日志蒸馏 → 摘要 + 清空 |

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

## 三、监控系统（已迁移 ✅）

> 已于 2026-06-08 实现。`src/system/` 包含：
> - `dashboard.ts` — 仪表盘：健康评分 + 项目分布 + agent_end 成功率 + 最近操作
> - `audit.ts` — 流程巡检：C1-C5 五阶段管线检查
> - `tracker.ts` — 问题追踪：待编译队列 + Tasks checkbox
> - `refresh.ts` — before_agent_start 自动刷新

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

### P3 — 健壮性增强 ✅

| # | 任务 | 说明 | 状态 |
|---|------|------|------|
| P3.1 | agent_end 去重增强 | markIngested + vault session_id 文件系统双重检查 | ✅ |
| P3.2 | startup recovery 增量优化 | 时间戳扫描 → processed-set 增量标记 | ✅ |
| P3.3 | 调试日志结构化 | dlog (临时) + slog (JSON → `~/.pi/agent/pi-llm-wiki.log`) | ✅ |

### P4 — 知识进化

| # | 任务 | 对应规则 | 状态 |
|---|------|---------|------|
| P4.1 | obs_compile 知识升级检测（2+ 项目→全局） | §7.2 | ✅ |
| P4.2 | obs_lint 矛盾检测（同主题多版本） | §7.2 | ✅ |
| P4.3 | obs_lint 重复内容检测（Jaccard） | §7.2 | ✅ |
| P-3 | obs_compile 编译前查重 | — | ✅ |
| P-4 | 管线失败恢复 | — | ✅ |

> 详细计划和审核见 `OPTIMIZATION_PLAN.md` 和 `AUDIT_PLAN.md`。

### P5 — 长期维护

| # | 任务 | 状态 |
|---|------|------|
| P5.1 | obs_aggregate：季度精华聚合 | ⬜ |
| P5.2 | obs_distill：经验日志蒸馏 | ⬜ |
| P5.3 | 自动化测试套件 | ⬜ |

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
    └── system/           # ✅ P1 — 监控页面生成
        ├── dashboard.ts  # 仪表盘生成器
        ├── audit.ts      # 流程巡检生成器
        ├── tracker.ts    # 问题追踪生成器
        ├── refresh.ts    # before_agent_start 自动刷新
        └── analyzer.ts   # P4 — 跨页文本分析（相似度/升级/矛盾/重复）
```

---

## 七、环境变量

```bash
# 推荐加到 ~/.bashrc
export OBSIDIAN_LLM_WIKI_KEY="your-obsidian-rest-api-key"
```
