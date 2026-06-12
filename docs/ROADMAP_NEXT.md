# 下一阶段路线图（终版）

> 整合 Oracle 评估 + Research 发现 + Review 反馈

---

## Phase 1：可靠性（P0，~2h）

### 1.1 agent-end hook 测试（1h）

**文件**：`tests/hooks.test.ts`（新建）

**方法**：不 mock 全局变量，使用依赖注入风格 — 构造虚构的 `pi.on()` 回调和 `sessionManager.getBranch()` 数据。

**测试用例**（7 个）：

| # | 测试 | 模拟数据 | 验证点 |
|---|------|----------|--------|
| 1 | autoIngest 注册 agent_end | `pi.on` spy | handler 被注册 |
| 2 | 已标记 session 跳过 | entries 含 `INGEST_MARKER` | 不调用 ingest |
| 3 | trivial 跳过（1 用户消息 + <200 字） | 1 条用户 msg + 2 条 assistant | 提前 return |
| 4 | trivial 跳过（很多 assistant 但内容少） | 1 条用户 msg + 5 条短 assistant | 提前 return |
| 5 | Tier 1（OM）摘要 | entries 含 `om.observations.recorded` | 摘要含 OM 内容 |
| 6 | Tier 2（extract）摘要 | 2+ 用户消息，无 OM | 摘要从消息提取 |
| 7 | 完整流程调用 ingest | 有效 entries | `ingest()` 被调用一次 |

### 1.2 startup-recovery.ts `any` 清零（0.5h）

| 行 | 当前 | 改为 |
|----|------|------|
| L62 | `let entry: any` | `let entry: Record<string, unknown>` |
| L90 | `extractText(msg: any)` | `extractText(msg: unknown)` |
| L97 | `.filter((b: any) => ...)` | `.filter((b: unknown) => ...)` |
| L98 | `.map((b: any) => b.text)` | `.map((b: Record<string, unknown>) => String(b.text ?? ""))` |

---

## Phase 2：效率（P1，~1h）

### 2.1 双轨状态迁移（0.5h）

**原则**：不破坏现有数据，新写入只设 `status`，读取时 `status` 优先 + 布尔回退。

**改动**：
- `markCompiled()` → 只写 `status: "compiled"`，不再写 `compiled: true`
- `markWeaved()` → 只写 `status: "woven"`，不再写 `weaved: true`
- `markLinted()` → 只写 `status: "done"`，不再写 `linted: true`
- `getStuckSessions()` + `getUncompiledSessions()` → 读取时 `status || fm.compiled` 双检查

**向后兼容**：旧文件（只有布尔字段）继续被正确识别。

### 2.2 孤页回链脚本（0.5h）

**文件**：`scripts/backfill-links.ts`

**逻辑**：
1. 扫描 `wiki/发现/` + `wiki/决策/` 中无入链的页面
2. 检查其内容中包含的 `[[wikilinks]]`
3. 对每个目标页面，检查目标页面是否有回链
4. 输出建议列表（不自动写入）

**不处理**：`wiki/引用/`（外部剪藏，天生孤页）

---

## Phase 3：优雅（P2，~1h）

### 3.1 retryCfg 透传 + 来源标记（0.5h）

- `tryExtract()` 接受 `retryCfg?` 参数，透传给 `callProvider()`
- 编译后的 wiki frontmatter 增加：
  - `compiled_by: "glm-4-flash" | "siliconflow" | "raw-copy"`（来源追踪）
  - `confidence: 1-5`（提取置信度，LLM=5, structured body=4, raw copy=1）

### 3.2 before-start hook 测试（0.5h）

**文件**：`tests/hooks.test.ts`（追加到 agent-end 测试之后）

**测试**：before_start hook 触发 refresh pipeline（auto-compile → auto-weave → auto-lint）的流程确认。

---

## 实施顺序

```
Phase 1.2 (0.5h) ─── 热身 any 清零
  → Phase 1.1 (1h) ─── 核心可靠性，hook 测试
    → Phase 2.1 (0.5h) ─── 状态迁移
      → Phase 2.2 (0.5h) ─── 孤页脚本
        → Phase 3.1 (0.5h) ─── retryCfg + 来源标记
          → Phase 3.2 (0.5h) ─── before-start 测试
```

## 验收标准

- [ ] `startup-recovery.ts` 中 `any` 注解清零
- [ ] `tests/hooks.test.ts` ≥7 个测试全部通过
- [ ] `npx tsx --test tests/*.test.ts` 全部通过，耗时 < 1s
- [ ] 新编译的 wiki 页面只写 `status` 字段，旧页面仍可识别
- [ ] `scripts/backfill-links.ts` 能扫描 104 页并输出建议
- [ ] wiki frontmatter 含 `compiled_by` 和 `confidence` 字段（当 LLM 提取时）
