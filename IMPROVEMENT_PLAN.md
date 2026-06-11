# pi-llm-wiki 改进实施计划

> 版本：2026-06-11（基于 Oracle 综合评估）  
> 状态：待实施  
> 参考：`OPTIMIZATION_PLAN.md`, `ROADMAP.md`, `AUDIT PLAN.md`

---

## 执行摘要

根据 Oracle 综合分析，推荐采用 **Approach B: "Consolidate + Incremental"** — 三核心改动：

1. **消除双编译路径**：`before_agent_start` 应委托给 `compile.ts` 而非运行自己的 `autoCompile`
2. **父子 Session 追踪**：通过 `parent_session_id` 防止子代理 fork session 泛滥
3. **变更日志增量处理**：用 `.changes.json` 替换全量目录扫描

当前核心问题：
- **37 篇 session 永久卡在"待编译"** — `refresh.ts` 的 `autoCompile` 有 bug：跳过重复项但不标记为已编译
- **21 篇 ERPNext fork session 内容重复** — 子代理 fork 各自创建 session，内容完全相同
- **每次启动全库扫描** — 614 页 + 113 raw sessions，每次 `before_agent_start` 都全量扫描

---

## Phase 0: 清理（迁移前准备）

**目标**：处理积压的 37 篇待编译 session 和 21 篇 ERPNext 重复 fork session

### 0.1 批量标记 stuck sessions

**文件**：`scripts/cleanup-stuck-sessions.ts`（新建）

**逻辑**：
```typescript
// 扫描 raw/sessions/ 中 compiled=false 但标题已存在 wiki 中的 session
// 批量标记为 compiled=true（跳过实际编译，因为这些内容已存在于 wiki）
```

**步骤**：
1. 读取所有 raw sessions 的 frontmatter
2. 读取所有 wiki 页面标题（构建标题索引）
3. 对于每个 raw session：
   - 如果标题已存在于 wiki 中 → 标记 `compiled: true`, `weaved: true`, `linted: true`, `skipped: "duplicate"`
   - 如果内容为空或<200 字符 → 标记 `compiled: true`, `skipped: "trivial"`
4. 写入 `.cleanup-report.json` 记录处理结果

**验收**：
- `raw/sessions/` 中 `compiled: false` 的文件从 37 降至 0
- 生成 `/tmp/cleanup-report.json` 包含处理统计

**风险**：低  
**依赖**：无  
**预估时间**：2 小时

---

### 0.2 ERPNext fork session 合并

**文件**：`scripts/merge-fork-sessions.ts`（新建）

**逻辑**：
```typescript
// 识别相同 parent goal 的 fork sessions（通过 session_id 前缀或内容相似度）
// 合并到一篇代表 session，其余标记为 skipped: "fork-merged"
```

**步骤**：
1. 读取 `raw/sessions/ERPNext/` 下所有 21 篇 session
2. 按 `### 🎯 目标` 内容分组（完全相同的归为一组）
3. 每组选最早的一篇作为代表
4. 其余标记为 `compiled: true`, `skipped: "fork-merged"`, `merged_into: <代表文件>`

**验收**：
- ERPNext 目录中 effective sessions 从 21 降至~5（按实际不同目标分组）
- `log.md` 记录合并操作

**风险**：低（只改 frontmatter，不改内容）  
**依赖**：0.1 完成后执行  
**预估时间**：1 小时

---

## Phase 1: 父子 Session 追踪

**目标**：在 ingest 层面识别并处理子代理 fork session，防止内容重复

### 1.1 `ingest.ts` 添加 `parent_session_id` 字段

**文件**：`src/tools/ingest.ts`

**修改位置**：
- 第 30-50 行：`buildTemplate()` 函数
- 第 60-90 行：`ingest()` 主函数

**改动**：
```typescript
// 1. 在 buildTemplate 中添加 parent_session_id 字段
const template = `---
title: "${firstLine}"
project: "${projectName}"
date: ${date}
session_id: "${sessionId}"
parent_session_id: "${ctx.parentSessionId ?? ""}"  // ← 新增
compiled: false
weaved: false
linted: false
tags: [session, ${projectName}${ctx.parentSessionId ? ', fork-session' : ''}]
---
...`;

// 2. 在 ingest 函数中检测 parent_session_id
export async function ingest(content: string, ctx: ExtensionContext) {
  const sessionId = (ctx as any).sessionManager?.sessionId ?? "";
  const parentSessionId = (ctx as any).parentSessionId ?? "";  // ← 从上下文获取
  
  // 3. 如果是 fork session，检查 parent 是否已 ingest
  if (parentSessionId) {
    const parentAlreadyIngested = await checkParentIngested(parentSessionId, projectName);
    if (parentAlreadyIngested) {
      // 标记为 fork，跳过实际 ingest（或合并到 parent）
      console.log(`[pi-llm-wiki] Fork session ${sessionId} skipped (parent ${parentSessionId} already ingested)`);
      return { path: "", project: projectName, writeMode: "skip" };
    }
  }
  
  // ... 原有的 session_id dedup 检查保持不变
}
```

**辅助函数**（新增）：
```typescript
async function checkParentIngested(parentSessionId: string, projectName: string): Promise<boolean> {
  const rawDir = path.join(VAULT_BASE, PATHS.rawSessions, projectName);
  try {
    const existing = fs.readdirSync(rawDir).filter((f) => f.endsWith(".md"));
    for (const f of existing) {
      const content = fs.readFileSync(path.join(rawDir, f), "utf-8");
      // 检查 parent_session_id 或 session_id 匹配
      if (content.includes(`session_id: "${parentSessionId}"`) ||
          content.includes(`parent_session_id: "${parentSessionId}"`)) {
        return true;
      }
    }
  } catch { /* dir may not exist yet */ }
  return false;
}
```

**边缘情况**：
- `parentSessionId` 为空字符串 → 正常 ingest（当作独立 session）
- parent session 不存在于 vault → 正常 ingest fork session
- 多次 fork（fork 的 fork）→ 递归检查顶层 parent

**验收**：
- 子代理 fork session 不再创建重复 raw 文件
- 现有独立 session 不受影响（`parentSessionId` 为空）
- 单元测试覆盖 fork 场景

**风险**：中（影响 ingest 核心逻辑）  
**依赖**：无  
**预估时间**：3 小时

---

### 1.2 `agent-end.ts` 传递 `parentSessionId`

**文件**：`src/hooks/agent-end.ts`

**修改位置**：
- 第 80-120 行：`autoIngest()` 函数

**改动**：
```typescript
export async function autoIngest(pi: ExtensionAPI): Promise<void> {
  pi.on("agent_end", async (event, ctx) => {
    // ... 现有逻辑 ...
    
    // 从 ctx 中提取 parent_session_id（如果存在）
    const parentSessionId = (ctx as any).parentSessionId ?? 
                            (ctx as any).forkParentId ?? 
                            "";
    
    // 传递给 ingest 时带上 parentSessionId
    await ingest(summary, { ...ctx, parentSessionId });
    
    // ... 剩余逻辑 ...
  });
}
```

**与 pi-subagents 集成**：
需要在 pi-subagents package 中添加：当创建 fork 时，在 ctx 中注入 `parentSessionId = ctx.sessionManager.sessionId`

**验收**：
- fork session 的 raw file frontmatter 中包含正确的 `parent_session_id`
- 单元测试验证 fork 识别

**风险**：低  
**依赖**：1.1 完成后  
**预估时间**：1 小时

---

## Phase 2: 单编译路径

**目标**：消除 `refresh.ts` 的 `autoCompile` 与 `compile.ts` 的逻辑重复，统一编译逻辑

### 2.1 `refresh.ts` 委托给 `compile.ts`

**文件**：`src/system/refresh.ts`

**修改位置**：
- 第 80-150 行：`autoCompile()` 函数（整函数替换）

**改动**：
```typescript
// 原 autoCompile() 函数有多处编译逻辑与 compile.ts 重复
// 替换为：扫描 pending sessions，逐个调用 compile.ts 的 compile() 函数

import { compile } from "../tools/compile";  // ← 新增导入

function autoCompile(): string[] {
  const pending = scanPendingSessions();
  const newWikiPaths: string[] = [];
  
  for (const rawPath of pending) {
    try {
      // 调用 compile.ts 的 compile 函数，而非本地重复逻辑
      const result = await compile(rawPath, {}, {} as ExtensionContext);
      
      if (result?.wikiPath) {
        if (result.dedupSuggestion) {
          // 编译时查重发现相似页面 → 记录跳过原因
          appendLog("compile", `${rawPath} → (跳过，${result.dedupSuggestion})`);
        } else {
          newWikiPaths.push(result.wikiPath);
          appendLog("compile", `${rawPath} → ${result.wikiPath}`);
        }
      }
    } catch (e: any) {
      console.error(`[pi-llm-wiki] auto-compile error for ${rawPath}: ${e.message}`);
    }
  }
  
  return newWikiPaths;
}
```

**关键修复**：
原 `autoCompile` 有 bug：
```typescript
// 原代码（有问题）:
if (existingPaths.has(wikiRelPath) || existingTitles.has(title)) {
  const updated = content.includes("compiled: false")
    ? content.replace("compiled: false", "compiled: true")
    : content;
  fs.writeFileSync(fullPath, updated, "utf-8");
  appendLog("compile", `${rawPath} → (跳过，已存在类似页面)`);
  continue;  // ← 这里虽然标记了 compiled: true，但实际没执行！
}
```

问题：`continue` 跳过了后续的标记逻辑。修复：
```typescript
// 修复后：
if (existingPaths.has(wikiRelPath) || existingTitles.has(title)) {
  // 调用 compile.ts 处理（它会返回 dedupSuggestion）
  const result = await compile(rawPath, {}, ctx);
  if (result?.dedupSuggestion) {
    appendLog("compile", `${rawPath} → (跳过，${result.dedupSuggestion})`);
  }
  // compile.ts 会自动标记 raw 为 compiled
  continue;
}
```

**边缘情况**：
- compile() 返回 `null`（文件找不到）→ 记录错误，继续处理下一个
- compile() 返回 `dedupSuggestion` → 跳过但标记为已编译
- compile() 成功 → 正常加入 `newWikiPaths`

**验收**：
- `tsc --noEmit` 编译通过
- 运行 `before_agent_start`，日志显示统一使用 `compile.ts` 逻辑
- 37 篇 stuck sessions 不再出现

**风险**：高（修改核心编译流程）  
**依赖**：Phase 0 完成后  
**预估时间**：4 小时

---

### 2.2 移除重复的模板处理逻辑

**文件**：`src/system/refresh.ts`

**修改位置**：
- 第 30-50 行：`applyTemplate()` 函数
- 第 200-280 行：`autoCompileZinbox()` 中的模板应用

**改动**：
- 删除 `applyTemplate()` 函数（compile.ts 已有完整模板处理）
- `autoCompileZinbox()` 也委托给 `compile.ts`（需扩展 compile.ts 支持 ZInBox 源）

**ZInBox 特殊处理**：
```typescript
// src/tools/compile.ts 扩展 ZInBox 支持
export async function compile(
  rawPath: string,
  params: { wikiType?: string; links?: string[]; sourceVault?: string },
  ctx: ExtensionContext
): Promise<CompileResult | null> {
  // 检测 ZInBox 源
  const isZinbox = rawPath.startsWith("zinbox://") || params.sourceVault === "ZInBox";
  
  if (isZinbox) {
    // ZInBox 特殊处理：直接读外部 vault，不经过 raw/sessions/
    // ... 现有逻辑适配 ...
  }
  
  // ... 常规编译逻辑 ...
}
```

**验收**：
- `refresh.ts` 中不再有任何 wiki 内容生成逻辑
- ZInBox auto-compile 仍正常工作

**风险**：中  
**依赖**：2.1 完成后  
**预估时间**：3 小时

---

## Phase 3: 增量变更日志

**目标**：用 `.changes.json` 替换全量目录扫描，加速 `before_agent_start`

### 3.1 添加变更追踪结构

**文件**：`src/config.ts`

**修改位置**：
- 第 40-60 行：添加变更追踪路径

**改动**：
```typescript
export const PATHS = {
  // ... 现有字段 ...
  /** Change log for incremental processing */
  changes: path.join(HOME, ".pi/agent/pi-llm-wiki-changes.json"),
  /** Full scan cache (fallback) */
  cache: path.join(HOME, ".pi/agent/pi-llm-wiki-cache.json"),
};

export const CHANGE_LOG = {
  /** Max entries to keep in change log */
  MAX_ENTRIES: 1000,
  /** Full scan interval (hours) */
  FULL_SCAN_INTERVAL: 24,
} as const;
```

**变更日志结构**：
```json
{
  "version": 1,
  "lastFullScan": "2026-06-11T00:00:00.000Z",
  "changes": [
    {
      "timestamp": "2026-06-11T12:30:00.000Z",
      "type": "ingest|compile|weave|lint",
      "path": "raw/sessions/Pi-Agent/2026-06-11-session.md",
      "action": "create|update|delete",
      "wikiPath": "wiki/决策/xxx.md"
    }
  ],
  "cache": {
    "rawSessions": ["raw/sessions/.../*.md"],
    "wikiPages": ["wiki/.../*.md"],
    "lastScanned": "2026-06-11T00:00:00.000Z"
  }
}
```

**验收**：
- TypeScript 编译通过
- 配置值可被其他模块导入

**风险**：低  
**依赖**：无  
**预估时间**：1 小时

---

### 3.2 `ingest.ts` / `compile.ts` / `weave.ts` 记录变更

**文件**：`src/tools/ingest.ts`, `src/tools/compile.ts`, `src/tools/weave.ts`

**修改位置**（每个文件）：
- 每个成功操作后调用 `logChange()`

**新增辅助函数**（`src/system/log.ts` 或新建 `src/system/changes.ts`）：
```typescript
interface ChangeEntry {
  timestamp: string;
  type: "ingest" | "compile" | "weave" | "lint";
  path: string;
  action: "create" | "update" | "delete";
  wikiPath?: string;
}

export async function logChange(entry: ChangeEntry): Promise<void> {
  const changes = await readChangeLog();
  changes.changes.push(entry);
  
  // Keep only last MAX_ENTRIES
  if (changes.changes.length > CHANGE_LOG.MAX_ENTRIES) {
    changes.changes = changes.changes.slice(-CHANGE_LOG.MAX_ENTRIES);
  }
  
  await writeChangeLog(changes);
}

export async function readChangeLog(): Promise<ChangeLog> {
  try {
    const data = fs.readFileSync(PATHS.changes, "utf-8");
    return JSON.parse(data);
  } catch {
    return { version: 1, lastFullScan: new Date().toISOString(), changes: [], cache: null };
  }
}

export async function writeChangeLog(changes: ChangeLog): Promise<void> {
  fs.writeFileSync(PATHS.changes, JSON.stringify(changes, null, 2));
}

export async function getCachedFiles(): Promise<{ raw: string[]; wiki: string[] }> {
  const changes = await readChangeLog();
  if (!changes.cache) return { raw: [], wiki: [] };
  return { raw: changes.cache.rawSessions, wiki: changes.cache.wikiPages };
}

export async function updateCache(rawFiles: string[], wikiFiles: string[]): Promise<void> {
  const changes = await readChangeLog();
  changes.cache = {
    rawSessions: rawFiles,
    wikiPages: wikiFiles,
    lastScanned: new Date().toISOString(),
  };
  await writeChangeLog(changes);
}
```

**验收**：
- 每次 ingest/compile/weave 操作后 `.pi/agent/pi-llm-wiki-changes.json` 有记录
- 日志文件不超过 MAX_ENTRIES 条

**风险**：中  
**依赖**：3.1 完成后  
**预估时间**：3 小时

---

### 3.3 `refresh.ts` 使用变更日志

**文件**：`src/system/refresh.ts`

**修改位置**：
- 第 60-80 行：`scanPendingSessions()` 函数
- 第 20-40 行：`refreshSystemPages()` hook

**改动**：
```typescript
import { readChangeLog, getCachedFiles, updateCache } from "../system/changes";

function scanPendingSessions(): string[] {
  // 优先使用缓存，回退到全量扫描
  const cached = getCachedFiles();
  
  // 检查是否需要全量扫描（缓存过期或不存在）
  const needsFullScan = !cached.raw || 
                        Date.now() - new Date(cached.lastScanned).getTime() > CHANGE_LOG.FULL_SCAN_INTERVAL * 3600000;
  
  if (needsFullScan) {
    // 全量扫描（现有逻辑）
    const pending = legacyScanPendingSessions();
    // 更新缓存
    const allRaw = collectAllRawSessions();  // 扫描目录
    const allWiki = collectAllWikiPages();   // 扫描目录
    updateCache(allRaw, allWiki);
    return pending;
  }
  
  // 增量扫描：只检查变更日志中的新文件
  return scanPendingFromChangeLog(cached.raw);
}

function scanPendingFromChangeLog(knownFiles: string[]): string[] {
  const changes = readChangeLog();
  const pending: string[] = [];
  
  // 只检查最近变更的文件
  for (const change of changes.changes) {
    if (change.type === "ingest" && change.action === "create" && change.path.startsWith("raw/sessions/")) {
      // 检查是否编译
      if (!isCompiled(change.path)) {
        pending.push(change.path);
      }
    }
  }
  
  return pending;
}
```

**边缘情况**：
- 变更日志文件损坏 → 回退全量扫描
- 缓存与文件系统不一致 → 全量扫描重新校准
- 首次运行（无缓存）→ 全量扫描

**验收**：
- 首次启动：全量扫描，生成缓存
- 后续启动：增量扫描（<1 秒 vs 原 10-30 秒）
- 每 24 小时强制全量扫描一次（防缓存漂移）

**风险**：高  
**依赖**：3.1, 3.2 完成后  
**预估时间**：4 小时

---

### 3.4 `status.ts` 使用缓存

**文件**：`src/system/status.ts`

**修改位置**：
- 第 20-50 行：`readAllRaw()`, `collectWikiFiles()` 函数

**改动**：
```typescript
import { getCachedFiles } from "./changes";

export function generateStatus(): string {
  // 使用缓存而非全量扫描
  const { raw: rawFiles, wiki: wikiFiles } = getCachedFiles();
  
  // 原逻辑使用 rawFiles 和 wikiFiles 而非扫描目录
  // ...
}
```

**验收**：
- 状态页生成时间从 5-10 秒降至<1 秒
- 数据准确性与全量扫描一致

**风险**：中  
**依赖**：3.3 完成后  
**预估时间**：2 小时

---

## Phase 4: 质量门控

**目标**：在 ingest 层面过滤 trivial sessions，减少垃圾内容流入 raw/sessions/

### 4.1 添加 "wiki worthiness" 评分

**文件**：`src/tools/ingest.ts`

**修改位置**：
- 第 60-90 行：`ingest()` 函数开头

**改动**：
```typescript
interface SessionScore {
  score: number;  // 0-100
  factors: {
    hasDecisions: boolean;
    hasInsights: boolean;
    userMessageCount: number;
    totalChars: number;
    hasCodeChanges: boolean;
    hasConfigChanges: boolean;
  };
}

function scoreSession(entries: any[]): SessionScore {
  const userMessages = extractUserMessages(entries);
  const totalChars = userMessages.reduce((sum, m) => sum + m.length, 0);
  
  const body = userMessages.join(" ");
  const hasDecisions = /决定 | 选择 | 采用 | 改成 | 配置 | 安装/i.test(body);
  const hasInsights = /发现 | 注意 | 陷阱 | 坑 | 理解 | 原因/i.test(body);
  const hasCodeChanges = /```[a-z]+\n[\s\S]*?```/.test(body);
  const hasConfigChanges = /\.json|\.yaml|\.toml|\.env|\.config/i.test(body);
  
  // 简单评分算法
  let score = 0;
  if (totalChars > 500) score += 20;
  if (totalChars > 2000) score += 20;
  if (userMessages.length > 5) score += 10;
  if (hasDecisions) score += 20;
  if (hasInsights) score += 15;
  if (hasCodeChanges) score += 10;
  if (hasConfigChanges) score += 5;
  
  return {
    score: Math.min(100, score),
    factors: {
      hasDecisions,
      hasInsights,
      userMessageCount: userMessages.length,
      totalChars,
      hasCodeChanges,
      hasConfigChanges,
    },
  };
}

export async function ingest(content: string, ctx: ExtensionContext) {
  // ... 现有逻辑 ...
  
  // 评分
  const entries = ctx.sessionManager?.getBranch?.() ?? [];
  const score = scoreSession(entries);
  
  // 低于阈值 → 标记为 trivial，跳过 ingest
  if (score.score < 30) {
    console.log(`[pi-llm-wiki] Trivial session skipped (score: ${score.score})`);
    // 可选：写入单独的 trivial sessions 目录用于调试
    // await writeToTrivial(ctx.sessionManager.sessionId, score);
    return { path: "", project: projectName, writeMode: "skip" };
  }
  
  // 在 frontmatter 中添加 score（用于后续分析和过滤）
  const template = `---
title: "${firstLine}"
project: "${projectName}"
date: ${date}
session_id: "${sessionId}"
parent_session_id: "${parentSessionId ?? ""}"
session_score: ${score.score}
trivial: ${score.score < 50}
compiled: false
...
`;

  // ... 剩余逻辑 ...
}
```

**阈值建议**：
- `<30`: 跳过（太 trivial，如单轮测试对话）
- `30-50`:  ingest 但标记 `trivial: true`（后续 autoCompile 可跳过）
- `>50`: 正常 ingest

**验收**：
- 单元测试覆盖各种 session 类型
- 实际运行中 trivial sessions 被过滤

**风险**：中（可能误杀有价值 session）  
**依赖**：无  
**预估时间**：3 小时

---

### 4.2 `refresh.ts` 跳过 trivial sessions

**文件**：`src/system/refresh.ts`

**修改位置**：
- `autoCompile()` 函数

**改动**：
```typescript
function autoCompile(): string[] {
  const pending = scanPendingSessions();
  const newWikiPaths: string[] = [];
  
  for (const rawPath of pending) {
    try {
      const content = await readFile(rawPath);
      const fm = parseFrontmatter(content);
      
      // 跳过 trivial sessions
      if (fm.trivial === true || fm.trivial === "true") {
        appendLog("compile", `${rawPath} → (跳过，trivial session)`);
        // 但仍标记为已编译，避免永久 pending
        await markCompiled(rawPath, { skipped: "trivial" });
        continue;
      }
      
      // ... 正常编译逻辑 ...
    } catch { /* ... */ }
  }
  
  return newWikiPaths;
}
```

**验收**：
- trivial sessions 不生成 wiki 页面
- `状态.md` 显示跳过数量

**风险**：低  
**依赖**：4.1 完成后  
**预估时间**：1 小时

---

## 实施顺序与依赖关系

```
Phase 0 (清理)
├── 0.1 cleanup-stuck-sessions (2h) ────────────────┐
└── 0.2 merge-fork-sessions (1h) ───────────────────┘
    │
    v
Phase 1 (父子追踪)
├── 1.1 ingest.ts + parent_session_id (3h) ────┐
└── 1.2 agent-end.ts 传递 parentId (1h) ───────┘
    │
    v
Phase 2 (单编译路径)
├── 2.1 refresh.ts 委托给 compile.ts (4h) ────┐
└── 2.2 移除重复模板逻辑 (3h) ────────────────┘
    │
    v
Phase 3 (增量处理)
├── 3.1 config.ts + changes.ts (1h) ───────────┐
├── 3.2 三工具记录变更 (3h) ───────────────────┤
├── 3.3 refresh.ts 使用变更日志 (4h) ──────────┤
└── 3.4 status.ts 使用缓存 (2h) ───────────────┘
    │
    v
Phase 4 (质量门控)
├── 4.1 ingest.ts session 评分 (3h) ───────────┐
└── 4.2 refresh.ts 跳过 trivial (1h) ──────────┘

总计：28 小时（约 3-4 个工作日）
```

---

## 测试策略

### 单元测试（新增/修改）

**文件**：`tests/unit.test.ts`

**新增测试用例**：
```typescript
// Phase 1
test("ingest skips fork session when parent already ingested", async () => { ... });
test("ingest handles empty parent_session_id correctly", async () => { ... });

// Phase 2
test("autoCompile delegates to compile.ts", async () => { ... });
test("compile.ts dedup suggestion works", async () => { ... });

// Phase 3
test("change log records ingest/compile/weave operations", async () => { ... });
test("incremental scan finds new sessions", async () => { ... });

// Phase 4
test("trivial session scoring", () => { ... });
test("single-message session score < 30", () => { ... });
test("session with decisions scores > 50", () => { ... });
```

### 集成测试（手动）

```bash
# Phase 0 后验证
cd ~/projects/.dotfiles/modules/pi-llm-wiki
npx tsx scripts/cleanup-stuck-sessions.ts
# 检查 raw/sessions/ 中 compiled: false 的数量

# Phase 1 后验证
# 运行一个子代理 fork 会话
# 检查是否只创建一篇 raw session（parent 的），fork 的不创建

# Phase 2 后验证
# 手动创建一篇 raw session
# 运行 before_agent_start，检查是否使用 compile.ts 逻辑编译

# Phase 3 后验证
# 测量启动时间（日志中的耗时）
# 对比全量扫描 vs 增量扫描时间差

# Phase 4 后验证
# 创建一个 trivial 会话（单轮对话）
# 检查是否未创建 raw session
```

---

## 风险与缓解

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| 1.1 破坏现有 fork session 处理 | 中 | 高 | 向后兼容：空 parent_session_id 时行为不变 |
| 2.1 编译逻辑改变导致内容差异 | 低 | 中 | 保留原模板作为 fallback，A/B 测试验证输出一致 |
| 3.3 缓存漂移导致漏扫描 | 中 | 中 | 每 24 小时强制全量扫描；损坏时回退扫描 |
| 4.1 误杀有价值 session | 中 | 低 | 初始阈值调低（20 而非 30）；记录所有跳过的 session 用于调优 |
| 整体制破坏现有 614 页 wiki | 低 | 高 | 所有改动只影响 raw/sessions/ 和新编译页面；现有 wiki 不动 |

---

## 验收标准

**Phase 0**：
- [ ] `raw/sessions/` 中 `compiled: false` 的数量从 37 降至 0
- [ ] ERPNext 目录中 effective unique sessions 从 21 降至≤5
- [ ] 生成 `/tmp/cleanup-report.json`

**Phase 1**：
- [ ] fork session 的 frontmatter 包含 `parent_session_id`
- [ ] 子代理 fork 不再创建重复 raw 文件
- [ ] 现有独立 session 不受影响

**Phase 2**：
- [ ] `tsc --noEmit` 编译通过
- [ ] `refresh.ts` 无 wiki 内容生成逻辑
- [ ] 37 篇 stuck sessions 不再出现

**Phase 3**：
- [ ] `.pi/agent/pi-llm-wiki-changes.json` 存在并记录变更
- [ ] `before_agent_start` 启动时间从 10-30 秒降至<5 秒
- [ ] 每 24 小时自动全量扫描一次

**Phase 4**：
- [ ] 单轮 trivial session 不创建 raw file
- [ ] `状态.md` 显示跳过的 trivial session 数量
- [ ] 有价值 session 正常 ingest

---

## 后续工作（可选增强）

- **语义去重**：使用 embedding 计算 session 内容相似度，识别重复内容（即使文本不同）
- **自动质量阈值调优**：收集被跳过的 session，定期回顾调整评分算法
- **Session 分组可视化**：在 Obsidian 中展示 parent-child session 关系图
- **批量历史数据迁移**：为现有 113 篇 raw sessions 补上 `parent_session_id`（如可从子代理上下文推断）

---

## 参考

- `OPTIMIZATION_PLAN.md` — 详细优化计划
- `ROADMAP.md` — 开发路线图
- `AUDIT_PLAN.md` — 审核计划
- Oracle 分析报告 — `/tmp/llm-wiki-oracle-synthesis.md`
- Research 报告 — `llm-wiki-research-findings.md`

---

## 总结

本计划采用 **Consolidate + Incremental** 策略：

1. **先清理积压**（Phase 0）— 解决眼前 37 篇 stuck sessions
2. **修复根源**（Phase 1-2）— 父子追踪 + 单编译路径，防止问题复发
3. **性能优化**（Phase 3）— 增量处理，加速启动
4. **质量提升**（Phase 4）— 门控 trivial content，提高 wiki 质量

总工期：**28 小时**（3-4 个工作日），风险控制：向后兼容 + 逐步验证。