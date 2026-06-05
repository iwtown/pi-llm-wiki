# pi-llm-wiki 开发与改进计划

> 目标：完整实现 schema.md 定义的 LLM-Wiki 工作流，达到原 `obsidian-knowledge.ts` 的功能完整度。
> 当前 `v1.0.0` 已实现核心 7 工具 + 2 hooks，TypeScript strict 零错误，全局安装就绪。

## 当前状态

### ✅ 已实现

| 组件 | 功能 | 状态 |
|------|------|------|
| `obs_ingest` | 会话复盘 → raw/sessions/ + log.md | ✅ |
| `obs_query` | 全文搜索 + frontmatter 富化 | ✅ |
| `obs_compile` | raw → wiki 编译 + 双链 | ✅ |
| `obs_weave` | 编译后织入已有页面 | ✅ |
| `obs_lint` | 孤立/过期/断裂链接检测 | ✅ |
| `obs_capture` | 查询洞察回流 wiki | ✅ |
| `obs_reference` | 跨库引用卡片 | ✅ |
| `before_start` | schema.md 注入 system prompt | ✅ |
| `agent_end` | 自动兜底复盘 | ✅ |
| `client.ts` | Obsidian REST API CRUD | ✅ |
| `manifest.ts` | session 编译/织入状态追踪 | ✅ |
| `project.ts` | 从 cwd 检测项目名 | ✅ |

### ❌ 缺失功能 vs schema.md

| 规则 | 需求 | 当前状态 |
|------|------|----------|
| 规则 3.5 | compile 前向用户展示关键发现并确认重点 | ❌ 未实现 |
| 规则 4 | compile 后返回 `linkedTo` 并**强制**提示 weave | ⚠️ 返回了 linkedTo 但未强制 |
| 规则 6 | compile 后自动更新 `wiki/图谱.md` | ❌ 未实现 |
| 规则 7 | 经验日志追加 + 月度蒸馏 | ⚠️ weave 做了日志追加，无蒸馏 |
| §7.2 | 知识升级：2+ 项目出现 → 升级为全局 | ❌ 未实现 |
| §7.2 | compile 时查重（同类洞察验证 N 次） | ❌ 未实现 |
| §7.2 | compile 时矛盾检测（与历史决策冲突） | ❌ 未实现 |
| §7.2 | agent 自检清单自动执行 | ❌ 未实现 |
| §8 | obs_query 多级检索策略（图谱 → grep → 搜索） | ⚠️ 只实现了全文搜索 |
| §8 | obs_query 深度控制（brief/normal/full） | ❌ 未实现 |
| §5 | 90 天 stale 自动标记 | ⚠️ lint 检测但不标记 |
| 季度聚合 | `obs_aggregate` 季度精华提取 | ❌ 未实现 |
| 仪表盘 | 系统页面自动更新（统计/计数） | ❌ 未实现 |
| agent_end | 智能判断：跳过已 ingest 的 session | ⚠️ 每次都创建 |
| Git | LLM-Wiki 自动提交触发 | ❌ 未实现（obsidian-git 独立运行） |

## 分阶段计划

### Phase 1: 工作流完整性（本周）

确保核心流水线（ingest → compile → weave → lint）闭环。

| # | 任务 | 改动 |
|---|------|------|
| 1.1 | `obs_compile` 返回更多元数据（insights 提取增强） | compile.ts |
| 1.2 | `obs_weave` 更新 `wiki/图谱.md`（规则 6） | weave.ts + 新函数 |
| 1.3 | `agent_end` 智能跳过：检测本 session 是否已调用 obs_ingest | agent-end.ts |
| 1.4 | 编译前确认机制：工具返回 mustConfirm=true 时 LLM 应暂停 | compile.ts + index.ts |

### Phase 2: 质量增强（下周）

让知识库自我进化，而非被动积累。

| # | 任务 | 改动 |
|---|------|------|
| 2.1 | `obs_lint` 增加矛盾检测（同一主题多版本标记冲突） | lint.ts |
| 2.2 | `obs_lint` 增加重复内容检测 | lint.ts |
| 2.3 | `obs_lint` 自动标记 stale（更新 frontmatter `status: stale`） | lint.ts |
| 2.4 | `obs_query` 实现多级策略：先读图谱 → 再 grep → 最后全文搜索 | query.ts |

### Phase 3: 知识升级（两周内）

实现 Karpathy 模式的完整知识生命周期。

| # | 任务 | 改动 |
|---|------|------|
| 3.1 | `obs_compile` 知识升级检测：同一洞察 ≥2 项目 → 提示升级全局 | compile.ts |
| 3.2 | 新工具 `obs_aggregate`：季度精华提取到 `wiki/记忆/YYYY/Qn.md` | 新文件 |
| 3.3 | 新工具 `obs_distill`：月度蒸馏 — 读经验日志 → 重写摘要 → 清空日志 | 新文件 |
| 3.4 | 系统页面自动更新（仪表盘统计、hot.md 热点） | 新文件 tools/system.ts |

### Phase 4: 健壮性（持续）

| # | 任务 | 改动 |
|---|------|------|
| 4.1 | REST API 不可用时的完整降级策略（文件系统直写） | client.ts |
| 4.2 | 并发写入保护（同一 vault 文件的锁） | client.ts |
| 4.3 | 错误恢复：ingest/compile 失败后的重试 | 各工具 |
| 4.4 | 性能：批量操作优化（读多个文件时合并请求） | client.ts |

## 测试策略

| 阶段 | 测试内容 | 频率 |
|------|----------|------|
| 日常使用 | 每次会话结束触发 ingest → 检查 raw/sessions/ 产出 | 每次 |
| Phase 1 完成 | 手动触发 compile → weave → lint 完整流程 | 一次性 |
| 积累 ≥5 篇 | 触发批量 compile 流程 | 按需 |
| Phase 2+3 | 每次 lint 对比输出，确认新检测项生效 | 每日 |
| 月底 | 运行 obs_aggregate 验证季度精华 | 每月 |

## 成功标准

- [ ] 5 次连续会话 → ingest → compile → weave → lint 流程无人工干预完成
- [ ] 图谱.md 每次 compile 后自动更新
- [ ] lint 报告覆盖所有 4 种检测类型（孤立/过期/矛盾/重复）
- [ ] 知识升级：至少 1 次从项目级升级为全局级的自动建议
- [ ] 0 次因 package 错误导致的数据丢失
