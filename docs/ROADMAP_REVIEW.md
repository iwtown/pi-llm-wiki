# Review: ROADMAP_NEXT.md

## Summary：需小幅修订后通过

计划结构合理，三阶段划分正确，实施顺序有逻辑。但存在 2 个 blocker 和 3 个 recommendation。

---

## 🔴 Blockers

### B1. Phase 2.1「双轨状态统一」会导致数据兼容问题

计划说 `getStuckSessions()` 和 `getUncompiledSessions()` "只认 status 字段"，但现存 **655 篇 wiki 页面和 188 篇 raw session 中，大部分有布尔字段但没有 status 字段**。直接改会导致这些页面被误判。

**修正方案**：保留 `||` 回退逻辑，但优先级改为 `status` > 布尔值：

```typescript
const isWoven = fm.status === "woven" || fm.status === "done" 
  || fm.weaved === true || fm.weaved === "true";
```

不删除旧字段判断，只是不再在新写入时设置布尔值。这不是「统一」而是「迁移」。

### B2. Phase 2.2「孤页回链补全」缺少精确范围界定

计划说扫描 `wiki/发现/` 和 `wiki/决策/` 共 104 页中的无入链页面。但：
- 部分页面确实是孤页（内容独立，不需要入链）
- 需要定义「什么情况下应当补链」的规则

**修正方案**：
- 只补链那些内容中提到了其他 wiki 页面但无回链的（有出链无入链）
- 跳过只有外部链接或没有链接的页面
- 脚本只输出建议，不自动写入

---

## 🟡 Recommendations

### R1. Phase 1.1 的 mock 方案需要具体化

"mock `pi.on()` 和 `ctx.sessionManager.getBranch()`" 太模糊。建议：

```typescript
// 创建模拟 pi API
const mockPi = {
  on: (event: string, handler: Function) => { registeredHandler = handler; },
  appendEntry: async () => {},
};

// 创建模拟 session entries
const mockEntries = [
  { type: "user", message: "帮我配置 WezTerm" },
  { type: "assistant", message: "好的，我来查看配置" },
  { type: "custom", customType: "om.observations.recorded", data: { observations: [...] } },
];
```

### R2. 缺少 Phase 0：清理 `research.md`

方案里 researcher 创建了 `/home/wtown/projects/.dotfiles/modules/pi-llm-wiki/research.md`（126 字节，空内容）。应在 Phase 1 前删除。

### R3. retryCfg 透传的工作量评估过低

"0.3h" 实际包括：改签名 → 改调用处 → 改测试 → 验证。从之前的经验看，还需要更新 `tryExtract` 的调用链，实测大约 0.5h。

---

## 最终评估

| 维度 | 评分 | 说明 |
|------|:----:|------|
| 结构 | ⭐⭐⭐⭐⭐ | Phase 顺序合理 |
| 可行性 | ⭐⭐⭐⭐ | B1 需修正 |
| 完整性 | ⭐⭐⭐⭐ | 缺少清理步骤 |
| 工作量估值 | ⭐⭐⭐ | R3 建议上调 |
| 验收标准 | ⭐⭐⭐⭐⭐ | 可量化、可测试 |

**判定：修正 B1+B2 后通过。总工作量约为 4h（含 review 反馈的调整）。**
