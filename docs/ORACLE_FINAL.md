# Oracle 综合评估 + 最终决定

> 基于：research brief + roadmap draft + roadmap review + 全部代码审计

---

## 1. 四原则评分

| 原则 | 评分 | 验证证据 |
|:----:|:----:|----------|
| **可靠性** | 3.5/5 | 管线完整无 stuck；fs/API 双 fallback；retry 有但 agent-end hook 0 测试 |
| **效率** | 4.5/5 | 57 测试 382ms；fs-first 避免不必要 API 调用；测试速度比初版提升 85x |
| **资源消耗** | 4/5 | 843 文件 < 10MB；每次 compile 至多 1 次 API；无浪费 |
| **优雅** | 3.5/5 | 模块分离好；双轨追踪是 debt；4 处 `any` 注解；空 catch 已修复 |

## 2. 研究洞察 → 计划调整

| 研究发现 | 对计划的影响 |
|----------|-------------|
| LLM-Wiki 不适合替代 OM（fast recall） | ✅ 现有 Tier1/2 设计正确，不改 |
| 114 内部孤页需关注，385 引用孤页可忽略 | ✅ 孤页补全范围缩小到 `wiki/发现/ + 决策/` 共 104 页 |
| Hook 测试是行业空白，是差异化机会 | ✅ Phase 1.1 优先级提高 |
| 应加 `compiled_by` 和 `confidence` 字段 | ➕ 新增到 Phase 3，标记 LLM vs raw copy 来源 |
| batch compile ≥5 是标准 | ✅ 已有，保持 |
| LLM 降级决策应显式记录 | ✅ `session_score < 50` 质量门控已实现 |

## 3. Review 反馈采纳决定

| Review 意见 | 决定 |
|-------------|:----:|
| B1：双轨统一会导致旧数据误判 | ✅ 改为「迁移」模式，保留 `\|\|` 回退 |
| B2：孤页范围界定 | ✅ 只补有出链无入链的页面，脚本只输出建议 |
| R1：mock 方案具体化 | ✅ 采纳，加入测试用例 |
| R2：清理 research.md | ✅ 已清理 |
| R3：工作量上调 | ✅ Phase 3.1 从 0.3h → 0.5h |

## 4. 最终路线图

### Phase 1：可靠性（~2h）
1.1 agent-end hook 测试 — mock pi.on + session entries，7 个用例
1.2 startup-recovery.ts `any` 清零 — 4 处

### Phase 2：效率（~1h）
2.1 双轨状态迁移 — `status` 优先，旧布尔保留兼容
2.2 孤页回链脚本 — `scripts/backfill-links.ts`，只输出建议

### Phase 3：优雅（~1h）
3.1 retryCfg 透传 + `compiled_by`/`confidence` 字段
3.2 before-start hook 测试

**总计：~4h**

### 不在此计划中的
- ZInBox 385 引用孤页（可接受）
- aggregate/distill/capture 测试（低频功能）
- 端到端 GLM 集成测试（需 API key，不适合自动化）
