# 记忆增强 v2 — 进度追踪

> 开始日期：2026-06-08
> 原则：稳定 → 高效 → 优雅
> 状态：✅ 全部完成

---

## 总进度

| 任务 | 内容 | 状态 | 完成度 |
|:----:|------|:----:|:------:|
| F1 | API 降级全工具 | ✅ | 100% |
| F2 | 概念缺页检测 | ✅ | 100% |
| F3 | Deep weave B1 | ✅ | 100% |
| F4 | log.md 补充 | ✅ | 100% |
| F5 | schema.md 精简 | ✅ | 100% |
| U | 被动观察者模式 | ✅ | 100% |
| **I** | **批量导入 87 个旧 pi session** | **✅** | **29 篇导入，52 篇跳过** |
| **P0** | **fs 优先 + auto-weave-auto-lint + query 描述优化** | **✅** | **100%** |

---

## 批量导入

| 来源 | 导入 | 跳过 | 说明 |
|------|:----:|:----:|------|
| pi 项目 sessions (81) | 29 | 52 | 跳过：≤1 条用户消息或 <200 字 |
| ~/.pi/ 配置 sessions (3) | 1 | 2 | 仅导入 13 条消息那篇 |

## P0 — 资源消耗优化

### client.ts → fs 优先
- 全部 CRUD (readFile/writeFile/listDir/exists/appendToFile/deleteFile) 改为 fs-first
- API 只做 fallback（当 fs 不可用时）
- search/smartSearch 保留 API-first（Omnisearch 结果更好，fs grep 做 fallback）

### refresh.ts → 完整管线
- auto-compile (≥5 篇触发) → auto-weave (追加关联回链) → auto-lint (记录健康报告) → 状态页
- 全在 before_agent_start hook 中完成，0 次 Agent 工具调用

### query 工具描述
- 增加 IMPORTANT 指引：已知分类优先读 Dataview 索引页（wiki/索引/xxx.md），obs_query 仅在模糊搜索时使用

## 变更汇总

| 文件 | 改动 |
|------|------|
| `src/client.ts` | 重写 — fs 优先，所有 CRUD 先 fs 再 API |
| `src/system/refresh.ts` | 重写 — auto-weave + auto-lint 补全管线 |
| `src/system/status.ts` | 新增 autoLint() |
| `src/index.ts` | query 工具描述增加 Dataview 索引引导 |
| `scripts/batch-import-pi.ts` | **新建** — 批量导入脚本 |
| `raw/sessions/pi/` | 29 个新文件 |
| `raw/sessions/home_wtown_.pi/` | 1 个新文件 |

## 仓库

| 仓库 | 提交 | 推送 |
|------|:----:|:----:|
| pi-llm-wiki | `697765b+` | 🔄 待推送 |
| vault | `bfbf78a+` | 🔄 待推送 |
| dotfiles | `f84afec+` | 🔄 待推送 |
