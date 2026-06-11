# 下一轮迭代计划：测试覆盖 + 代码洁癖

> 基于 Oracle 终审（ORACLE_REVIEW.md）。不与现有 OPTIMIZATION/IMPROVEMENT 计划冲突——那些已完成。

---

## 为什么要先做测试

当前代码库 **10 个核心源文件无任何测试覆盖**：

```
🟢 有测试:  manifest.ts  status.ts  analyzer.ts  parse.ts  client.ts (API)
🔴 无测试:  ingest.ts  compile.ts  weave.ts  lint.ts  refresh.ts
             changes.ts  recovery.ts  capture.ts  aggregate.ts  distill.ts
```

这意味着重构或添加功能时，只能靠手动验证。**这是回归风险，不是功能缺失**。

---

## Phase 6：测试覆盖 (6-8h)

### 6.1 管线集成测试 (4h)

**文件**：`tests/pipeline.test.ts`（新建）

**方案**：使用 `/tmp/test-vault/` 隔离目录，不碰主 vault。

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const TEST_VAULT = "/tmp/test-vault-llm-wiki";
const SESSIONS_DIR = path.join(TEST_VAULT, "raw/sessions/test-project");

// Setup: 创建临时 vault 结构
function setupTestVault() {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  // 设置环境变量指向测试 vault
  process.env.LLM_WIKI_VAULT = TEST_VAULT;
}

// Teardown: 清理
function teardownTestVault() {
  fs.rmSync(TEST_VAULT, { recursive: true, force: true });
}
```

**测试用例**（6 个）：

| # | 测试 | 验证点 |
|---|------|--------|
| 1 | `ingest` 写入 raw session | frontmatter 含 title/project/session_id/status/session_score |
| 2 | `ingest` fork session 去重 | `parent_session_id` 匹配时返回 skip |
| 3 | `ingest` trivial session 跳过 | score <30 时返回 skip |
| 4 | `compile` raw→wiki | wiki 页创建，status 变为 compiled |
| 5 | `compile` 查重 | 相同 title 时返回 dedupSuggestion |
| 6 | `weave` 追加经验日志 | 目标页出现 📋 经验日志 |

### 6.2 change log 测试 (1h)

**文件**：`tests/changes.test.ts`（新建）

| # | 测试 | 验证点 |
|---|------|--------|
| 1 | `logChange` 写入 | 文件存在，内容包含 type/path/action |
| 2 | `readChangeLog` 空状态 | 文件不存在时返回默认结构 |
| 3 | `needsFullScan` 缓存过期 | 24h 后返回 true |
| 4 | `isRelevantPendingPath` 过滤 | raw/sessions/*.md 返回 true，其他 false |

### 6.3 scoreContent 测试 (1h)

**文件**：`tests/score.test.ts`（新建，或追加到现有 test 文件）

| # | 测试 | 验证点 |
|---|------|--------|
| 1 | 结构化内容（🎯+⚖️+💡+⚠️） | score > 80 |
| 2 | 普通内容（>2000 字无章节） | score ≈ 30（不触发 trivial） |
| 3 | 短内容（<300 字无章节） | score = 0 → isTrivial |
| 4 | 边界：刚好 800 字 + 1 章节 | score = 35（不 trivial） |

### 6.4 空 catch 填充 (0.5h)

**文件**：`src/system/refresh.ts`

```typescript
// 第 60 行
} catch {} → } catch { /* 日志轮转失败非致命 */ }
// 第 473 行
} catch {} → } catch { /* 洞察文件不存在正常 */ }
```

---

## Phase 7：代码洁癖 (2-3h)

### 7.1 类型安全：减少 `as any` (1h)

**方法**：在 `src/types.ts`（新建）定义扩展上下文类型：

```typescript
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface ExtendedContext extends ExtensionContext {
  parentSessionId?: string;
  forkParentId?: string;
}
```

修改 **3 个文件**中的 `as any`：

| 文件 | 替换 |
|------|------|
| `hooks/agent-end.ts:203,234-235,242` | `ctx as any` → `ctx as ExtendedContext` |
| `tools/ingest.ts:154,189` | `ctx as any` → `ctx as ExtendedContext` |
| `system/refresh.ts:162` | `{ cwd: ... } as any` → `{ cwd: ... } as ExtensionContext` |

### 7.2 删除冗余的研究文件 (0.5h)

`llm-wiki-research-findings.md` 和 `plan.md` 是中间产物，内容已汇入正式计划文档。

### 7.3 测试运行脚本 (0.5h)

在 `package.json` 中添加 `test:pipeline` script：

```json
"scripts": {
  "test": "tsx --test tests/unit.test.ts",
  "test:pipeline": "tsx --test tests/pipeline.test.ts tests/changes.test.ts",
  "test:all": "tsx --test tests/*.test.ts"
}
```

---

## 实施顺序

```
Phase 6.4 空 catch (0.5h) ── 低风险热身
  → Phase 7.1 类型安全 (1h) ── 需要编译验证
    → Phase 6.3 scoreContent (1h) ── 纯函数，无依赖
      → Phase 6.2 changes (1h) ── 文件系统隔离
        → Phase 6.1 pipeline (4h) ── 最大块
          → Phase 7.2 清理 (0.5h) + 7.3 脚本 (0.5h)
```

**总计：8-11 小时**

---

## 不在此计划中的（避免冲突）

| 内容 | 原因 |
|------|------|
| ZInBox 深度集成到 standard pipeline | 当前 hybrid 方案够用，无需改架构 |
| LLM 回退提取器 | 过于复杂，<=2 条消息的 session 不值得用 LLM |
| contradiction/duplicate 检测降频 | 当前跑一次 <1s，不构成性能问题 |
| dlog/slog 合并 | 不影响功能，纯内部治理 |
| 新增功能（capture/aggregate/distill 增强）| 等测试覆盖完成后 |
| 写操作导出 `scoreContent` / `SessionScore` | 已从 ingest.ts 导出 |

---

## 验收标准

- [ ] `npx tsx --test tests/*.test.ts` 全部通过
- [ ] 管线集成测试覆盖 ingest→compile→weave 全链路
- [ ] `changes.ts` 4 个关键函数有测试
- [ ] `scoreContent()` 覆盖 4 种质量级别
- [ ] `as any` 从 11 处降至 ≤4 处（合法的 ExtensionContext 扩展）
- [ ] 无空 `catch {}`（至少有注释）
- [ ] `package.json` 包含 `test:pipeline` 和 `test:all` scripts
- [ ] 中间产物文件已清理
