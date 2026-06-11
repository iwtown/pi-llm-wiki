# Oracle 分析：pi-llm-wiki 综合评审

> 基于全部 19 个 TypeScript 源文件 + vault 数据分析

---

## 核心使命

pi-llm-wiki 是 Pi Agent 的**长期记忆底座**，需要做到三件事：
1. 所有 sessions + ZInBox 剪藏 + 用户笔记正确录入
2. 高质量提取知识（goals/decisions/insights）
3. Pi Agent 可靠、正确、高效地使用产物

---

## 1️⃣ 可靠性 (Reliability) — 评分：🟡 B+

### 做得好的
- **写入容错**：fs-first + REST API fallback，写入失败时静默降级
- **崩溃恢复**：`startup-recovery.ts` 扫描孤儿 .jsonl，增量去重（processed set）
- **去重**：session_id → parent_session_id → scoreContent 三级过滤
- **管线恢复**：`recovery.ts` 扫描 compiled 但未 weaved 的 session
- **Git 备份**：5min 提交 / 15min 推送

### 薄弱环节
- **ZInBox 绕过了质量控制**：`autoCompileZinbox()` 直接写 wiki/引用/，未经 ingest→compile→weave→lint 管线，无 parent tracking，无 insight 提取，无知识升级检测
- **Bimodal 提取质量**：OM 可用时输出结构化高，fallback 时只是拼接用户消息
- **管线状态跟踪脆弱**：compiled/weaved/linted 三个布尔字段（Phase 0 暴露了空字符串 vs false 的 YAML 解析问题）
- **无写入前日志**：writeWithFallback 成功但 logChange 失败 → 不一致

---

## 2️⃣ 效率 (Efficiency) — 评分：🟡 B

### 做得好的
- **增量扫描**：changes.json 替代全量扫描，启动从 O(727) → O(changes)
- **fs-first**：直接读取 /mnt/d/，比 REST API 快一个数量级
- **schema 缓存**：5min TTL，避免每次启动读 API

### 薄弱环节
- **ZInBox 每次启动全量扫描**：autoCompileZinbox() 遍历 ~400 文件，O(400) 额外开销
- **autoCompileZinbox 双收集 wiki pages**：既做 existingPaths 又做 existingTitles，都是 `collectWikiPages()` 全量扫描
- **schema 注入重试延迟**：最多阻塞 1.5s
- **大 vault 633 页**：status.ts 的 generateStatus() 仍是全量扫描（虽然只发生在 before_agent_start）

---

## 3️⃣ 简洁性 (Simplicity) — 评分：🟡 B-

### 做得好的
- **三层模型**（raw → compile → wiki）清晰
- **hook + tool 分离** 正确
- **5 Phase 改进了架构**，消除了双编译路径

### 过度复杂
- **obs_admin 工具混了 4 个动作**：capture/reference/aggregate/distill 共用一个 tool，参数完全不同
- **compiled/weaved/linted 三状态跟踪**：不如一个 `status: pending|compiled|weaved|done` 字段简洁
- **双日志系统**：dlog (human-readable) + slog (JSON structured) 同类型信息写两个文件
- **矛盾检测**：lint.ts 的 detectContradictions() 在 <1000 页规模下几乎从不触发
- **agent_end.ts 中 buildAutoSummary vs buildFallbackSummary**：两个独立函数，50% 逻辑重复

### 概念数量
核心概念：ingest → compile → weave → lint → query → capture → aggregate → distill
辅助概念：parent_session_id, session_score, trivial, changes.json, crash-recovery
→ 共 13 个概念。对于一个 Agent 记忆系统来说合理但偏多。

---

## 4️⃣ 优雅性 (Elegance) — 评分：🔴 C+

### 最大的设计债：ZInBox 是二等公民

```
正常管线: ingest → raw/sessions/ → compile → wiki/发现/
ZInBox 剪藏:  autoCompileZinbox() → wiki/引用/   (跳过整个管线)
```

ZInBox 有自己的编译路径、自己的 marker index、自己的 wiki 类型、自己的 hub page。它不经过：
- scoreContent 质量门控
- parent_session_id 追踪
- insight 提取
- 知识升级检测
- 管线状态跟踪

这是最大的优雅性违反——同样的输入走完全不同的路径。

### 其他设计债

- **startup-recovery.ts 重复 agent-end.ts 逻辑**：两套 parseSession/extractText/findOrphan
- **scoreContent() 阈值无数据支撑**：30/50/100 是拍脑袋
- **agent_end 与 startup-recovery 双向竞态可能**：mem 缓存去重有效但脆弱

---

## 🔴 综合判断

### 能可靠、正确、高效地使用吗？ → 基本能（B级）

核心管线（sessions → raw → wiki → query）在 5 Phase 改进后是**可靠且正确的**：
- 写入有容错
- 去重有三层
- 编译有唯一路径
- 检索有三级深度（atlas → semantic → full-text）

**但不是优雅的（C+）。** 最主要的两个障碍：

### 障碍 1：ZInBox 作为平行管线
绕过 ingest→compile 管线，无质量门控。每次启动全量扫描拖累效率。

### 障碍 2：提取质量 bimodal（/ˈbaɪˌmoʊdəl/ 双模态分布）
```
OM 可用 → `buildAutoSummary()` → 结构化 🟢 ｜ OM 不可用 → `buildFallbackSummary()` → 用户消息拼接 🟡
```
这导致 raw/sessions/ 中的质量分布是双峰的——好的很好，差的就是用户消息拼接。

### 障碍 3：管线状态跟踪过度设计
compiled/weaved/linted 三个布尔字段不如一个 `status: pending|compiled|woven|done`。

### 如果重构

**不需要重写**。核心架构是对的。需要的是：

1. **ZInBox 采纳（onboarding）到标准管线** — 让 ZInBox 走 ingest→compile→weave 或至少 scoreContent 门控
2. **合并 summarizer** — `buildAutoSummary` 和 `buildFallbackSummary` 合并为一个函数，有 OM 用 OM，无 OM 用更强的 fallback（不只是拼接用户消息，而是用 LLM 提取结构化内容）
3. **简化状态跟踪** — 一个 status 字段替代三个 boolean
4. **削减过度检测** — contradiction / duplicate 检测降频或移除

这些改动预计需要 **16-24 小时**，其中 ZInBox 采纳占 60%。
