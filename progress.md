# 记忆增强 v2 — 进度追踪

> 开始日期：2026-06-08
> 原则：稳定 → 高效 → 优雅
> 状态：✅ 全部完成

---

## 总进度

| 任务 | 内容 | 状态 | 完成度 |
|:----:|------|:----:|:------:|
| F1 | API 降级全工具（消除单点故障） | ✅ | 100% |
| F2 | 概念缺页检测 | ✅ | 100% |
| F3 | Deep weave B1 增强触点 | ✅ | 100% |
| F4 | log.md 补充 | ✅ | 100% |
| F5 | schema.md 精简 | ✅ | 100% |

---

## F1 — API 降级全工具

> 目标：所有 client.ts 函数在 REST API 不可用时自动降级到 vault 文件系统

### 改动

- `src/client.ts` — 所有函数（readFile/writeFile/listDir/exists/appendToFile/deleteFile）添加 API → fs 双路径

### 结果

- tsc ✅ 零错误
- 34 tests ✅ 全过

---

## F2 — 概念缺页检测

> 目标：lint 能报告被多次引用但页面不存在的概念

### 改动

- `src/system/analyzer.ts` — 新增 `detectMissingConcepts(WikiPage[], threshold?)`
- `src/tools/lint.ts` — 调用概念缺页检测，输出 warning
- `src/config.ts` — 新增 `ANALYSIS.MISSING_CONCEPT_THRESHOLD`
- `tests/unit.test.ts` — 新增 4 个测试（基础检测、可配阈值、wikilink 变体处理、排除系统页）

### 结果

- tsc ✅
- 34 tests ✅（新增 4 个概念缺页测试）
- `obs_lint` 能报告形如 `概念 "xxx" 在 N 个页面中被引用但无对应页面` 的 warning

---

## F3 — Deep Weave B1 增强触点

> 目标：weave 不只更新 linkedTo，自动扫描全库找到相关页面

### 改动

- `src/system/analyzer.ts` — 新增 `findRelatedPages()`（Jaccard 相似度匹配 insights 与页面 title+body）
- `src/tools/weave.ts` — B1 逻辑：更新 linkedTo 后扫描相关页，上限 `WEAVE_MAX_CONTACTS=10`
- `src/config.ts` — 新增 `ANALYSIS.WEAVE_RELEVANCE_THRESHOLD=0.2`, `WEAVE_MAX_CONTACTS=10`

### 结果

- tsc ✅
- 34 tests ✅
- weave 一条 session 触及页面上限 10 页（linkedTo + 语义相关页）

---

## F4 — log.md 补充

> 目标：log.md 记录 query 和 lint

### 改动

- `src/tools/query.ts` — 每次查询后追加 `## [YYYY-MM-DD] query | "关键词" → N 条结果 (scope, depth)`
- `src/tools/lint.ts` — 每次 lint 后追加 `## [YYYY-MM-DD] lint | N 个问题 (E errors, W warnings, I info)`

### 结果

- tsc ✅
- 34 tests ✅

---

## F5 — schema.md 精简

> 目标：从 8 节 7 规则砍到 4 条核心规则

### 改动

- `schema.md` — 重构为：4 条 Core Rules (R1-R4) + 流程表 + 快速参考 + 可选参考

### 结果

- 注入 system prompt 后 Agent 只需关注 4 条核心规则
- 其余归入"参考"章节，Agent 可按需忽略
- 文件从 3.5KB 精简到 3.7KB（结构精简但信息保留）
