# pi-llm-wiki 开发计划书

> 版本：`v1.0.0` → 持续优化  
> 安装：`~/pi-llm-wiki/`，全局 local package，`pi install` 注册  
> 依赖：Obsidian Local REST API (`localhost:27126`) + `pi-observational-memory`

---

## 一、当前版本确认（v1.0.0）

### 安装验证

| 检查项 | 状态 |
|--------|------|
| 全局注册 (`~/.pi/agent/settings.json`) | ✅ `"../../pi-llm-wiki"` |
| `package.json` 符合 Pi 规范 (`pi.extensions`) | ✅ |
| TypeScript strict 编译 | ✅ 零错误 |
| 14 个源文件完整 | ✅ |
| Git 版本管理 (7 commits) | ✅ |

### 7 工具全部可用

| 工具 | 验证 | 备注 |
|------|------|------|
| `obs_ingest` | ✅ | 格式正确：title/project/session_id/compiled 全字段 |
| `obs_query` | ✅ | 全文搜索 + frontmatter 富化 |
| `obs_compile` | ✅ | raw → wiki + 双链 + markCompiled |
| `obs_weave` | ✅ | 回链 + 经验日志追加 |
| `obs_lint` | ✅ | 孤立/过期/断裂链接检测 |
| `obs_capture` | ✅ | 洞察回流 |
| `obs_reference` | ✅ | 跨库引用卡片 |

### 2 Hooks 工作正常

| Hook | 验证 | 备注 |
|------|------|------|
| `before_agent_start` | ✅ | schema.md 注入 system prompt，5min 缓存 |
| `agent_end` | ✅ | 去重（markIngested）+ 读取 observational-memory 生成有内容复盘 |

### 已修复的关键问题（本次会话）

| 问题 | 修复 | Commit |
|------|------|--------|
| API key 硬编码 | 环境变量 `OBSIDIAN_LLM_WIKI_KEY` + 单次警告 | `1832d42` |
| `detectProject` 只取 basename (pi vs Pi-Agent) | 读 AGENTS.md `#` 标题 | `a23e110` |
| `agent_end` 每次创建空壳 | markIngested 去重 | `8d12438` |
| `agent_end` 无内容空壳 | 集成 pi-observational-memory 提取 observations | `c18f7be` |
| `package.json` 非规范字段 | `pi.extensions` 替代自定义字段 | `fd35dd7` |
| 断链检测死逻辑 (lint.ts) | 修复匹配逻辑 | 审计修复 |
| YAML frontmatter 转义缺失 | `quoteYaml()` 函数 | 审计修复 |
| 多处未使用导入 | 清理 | 审计修复 |

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

## 三、待优化清单（按优先级）

### P0 — 数据完整性（下次使用前）

| # | 任务 | 原因 |
|---|------|------|
| P0.1 | 设置 `OBSIDIAN_LLM_WIKI_KEY` 环境变量 | 消除控制台警告 |
| P0.2 | agent_end 复盘需记录当前 session 的 cwd/项目 | 目前 project detection 依赖 ctx.cwd |

### P1 — 工作流闭环（✅ 已完成 — commit `4121112`）

| # | 任务 | 对应 schema 规则 | 状态 |
|---|------|-----------------|------|
| P1.1 | `obs_weave` 自动更新 `wiki/图谱.md` | 规则 6 | ✅ 已实现 |
| P1.2 | `obs_compile` 显示提取的 insights 数量和内容 | 规则 3.5 (编译前确认) | ✅ 已实现 |
| P1.3 | `obs_lint` 自动标记 stale（`fix=true` 更新 frontmatter） | 规则 5 | ✅ 已实现 |
| P1.4 | `obs_query` 多级检索：图谱 → REST API | §8 | ✅ 已实现 |

### P2 — 知识进化（两周内）

| # | 任务 | 对应 schema 规则 |
|---|------|-----------------|
| P2.1 | `obs_compile` 知识升级检测（2+ 项目 → 全局） | §7.2 |
| P2.2 | `obs_lint` 矛盾检测（同一主题多版本） | §7.2 |
| P2.3 | `obs_lint` 重复内容检测 | §7.2 |
| P2.4 | `obs_query` 深度控制实现（brief/normal/full） | §8 | ✅ 已实现（参数已添加） |

### P3 — 长期维护（月度）

| # | 任务 |
|---|------|
| P3.1 | 新工具 `obs_aggregate`：季度精华 → `wiki/记忆/YYYY/Qn.md` |
| P3.2 | 新工具 `obs_distill`：读经验日志 → 重写摘要 → 清空 |
| P3.3 | 系统页面自动更新（仪表盘统计） |
| P3.4 | REST API 不可用时的文件系统直写降级 |

---

## 四、测试与验证策略

| 频率 | 测试 | 验收标准 |
|------|------|----------|
| **每次会话** | agent_end 是否产生空壳？ | 0 空壳 |
| **每次会话** | obs_ingest 格式是否完整？ | title/project/session_id/compiled 全字段 |
| **每周** | 未编译 raw ≥5 时触发 compile → weave → lint | 全链无错误 |
| **每周** | lint 报告 0 error | error=0, warning 递减 |
| **每月** | 图谱.md 是否最新 | 含本月所有新页面 |
| **按需** | tsc strict 编译 | 零错误 |

---

## 五、目录结构

```
~/pi-llm-wiki/
├── package.json          # Pi package manifest (pi.extensions)
├── ROADMAP.md            # 本文件
├── .gitignore
└── src/
    ├── index.ts          # 入口：注册 7 tools + 2 hooks
    ├── config.ts         # Vault 路径、API key、阈值
    ├── client.ts         # Obsidian REST API 封装
    ├── manifest.ts       # 编译/织入/linted 状态追踪
    ├── project.ts        # 项目检测（AGENTS.md 标题）
    ├── hooks/
    │   ├── before-start.ts   # schema.md 注入 system prompt
    │   └── agent-end.ts      # 智能兜底 + observational-memory 集成
    └── tools/
        ├── ingest.ts     # obs_ingest
        ├── query.ts      # obs_query
        ├── compile.ts    # obs_compile
        ├── weave.ts      # obs_weave
        ├── lint.ts       # obs_lint
        ├── capture.ts    # obs_capture
        └── reference.ts  # obs_reference
```

---

## 六、环境变量

```bash
# 推荐加到 ~/.bashrc
export OBSIDIAN_LLM_WIKI_KEY="5b484f2a70fb254383feaed8fe92604841f5fd2eda221e1fa8ec0e50839b1a9e"
```
