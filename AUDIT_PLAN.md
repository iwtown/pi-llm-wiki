# pi-llm-wiki × Obsidian 终极审计与优化计划

> 版本：2026-06-08 深度审计  
> 状态：P0-P3 ✅ | 盲区 G1-G8 已修 ✅ | 配置审计 ⏳ | P4 待实施

---

## 一、当前状态精确画像

### 1.1 Vault 规模

| 指标 | 值 |
|------|-----|
| Vault 总大小 | 15 MB（其中 12 MB 是插件代码） |
| wiki/ 页面 | 77 页（29 发现 + 15 项目 + 其余 33） |
| raw/sessions/ | 43 个（Pi-Agent 38 + 其他 5） |
| pi-llm-wiki 代码 | 2728 行 TypeScript |
| 社区插件 | 15 个（全部启用） |
| 核心插件 | 17/31 启用 |

### 1.2 插件分级

| 等级 | 插件 | 说明 |
|:--:|------|------|
| 🔴 核心 | REST API, Obsidian Git, Dataview | 基础设施，不可停 |
| 🟠 重要 | Smart Connections, Omnisearch, Templater, Linter, Tasks | 直接影响工作流 |
| 🟡 辅助 | Kanban, Auto Note Mover, Strange New Worlds, Floating TOC | 可视化/整理 |
| 🟢 工具 | Cmdr, Note Refactor, Tag Wrangler | 偶尔手动使用 |

> ✅ **零冗余**：15 个插件各司其职，无功能重叠。

---

## 二、插件配置问题（逐项）

### 2.1 🔴 需立即修复

| 插件 | 问题 | 修复 |
|------|------|------|
| **Smart Connections** | 无预建索引，首次启动全量扫描 77 个 wiki 页 + 43 个 raw | 手动触发一次初始索引，或接受首次启动慢 |
| **Obsidian Git** | `showErrorNotices: false` — push 失败无提示 | 改为 `true`，至少让用户感知 |
| **Linter** | `lintOnSave: true` 但 `displayChanged: false` — 改了文件但人看不到提示 | 改为 `true` |
| **Graph** | 无颜色分组 — 77 个节点一团灰 | 按 wiki 类别着色 |

### 2.2 🟡 建议优化

| 插件 | 当前 | 建议 | 理由 |
|------|------|------|------|
| **Omnisearch** | `recencyBoost: "0"` | 保持 `"0"` | wiki 知识是永恒的，不需要时效性权重 |
| **Templater** | `auto_jump_to_cursor: true` | 保持 | 新建页面后光标自动跳到模板占位符 |
| **Tasks** | `globalQuery: ""` | 保持 | 全局过滤会干扰其他 vault 的 Tasks 用法 |
| **Kanban** | `lane-width: 220` | 改为 `240` | 中文标题需要更宽 |
| **Floating TOC** | `defaultCollapsedLevel: 6` | 保持 | 深度页面（如 schema.md）不折叠 |

### 2.3 🟢 无需改动

| 插件 | 原因 |
|------|------|
| **Dataview** | 0 配置 = 全默认，查询语法内嵌在页面中，无全局设置需求 |
| **Strange New Worlds** | 0 配置 = 全默认，引用计数即关键功能 |
| **Tag Wrangler** | 0 配置 = 全默认，手动标签管理工具 |
| **Cmdr** | 预配置空宏列表，用户自行添加常用命令 |
| **Note Refactor** | 已设模板 + split 规则，够用 |
| **REST API** | 端口 + API key 已配置，`.gitignore` 排除 |

---

## 三、工作流可靠性检查

### 3.1 写入路径

```
Pi 会话结束
  ├─ agent_end 触发 ✅
  │   ├─ markIngested 去重 ✅
  │   ├─ 内存缓存去重 ✅
  │   ├─ 最小会话过滤 ✅
  │   ├─ OM 数据 / fallback 原始消息 ✅
  │   └─ ingest → REST API → fs 降级 ✅
  │
  ├─ 崩溃恢复 ✅
  │   └─ agent_start → startup_recovery → processed-set 增量扫描 ✅
  │
  ├─ 系统监控 ✅
  │   └─ before_agent_start → refresh 三页面 ✅
  │
  └─ 日志 ✅
      ├─ dlog → ~/.pi/agent/pi-llm-wiki-debug.log ✅
      └─ slog → ~/.pi/agent/pi-llm-wiki.log (JSON, 1MB rotate) ✅
```

| 风险点 | 缓解措施 | 残留风险 |
|--------|---------|---------|
| Obsidian 未启动时写入 | fs 降级直接写文件 ✅ | Obsidian 不感知新文件，需手动刷新 |
| REST API 超时 | 15 秒 AbortSignal ✅ | 网络极差时卡 15 秒 |
| Git 推送失败 | `showErrorNotices: false` ❌ | → **需改为 true** |
| Smart Connections 索引失败 | slog 记录 ✅ | 语义搜索不可用但 REST API 仍工作 |

### 3.2 读取路径

```
Agent 调用 obs_query
  ├─ 图谱.md 扫描 ✅
  ├─ REST API Simple Search ✅
  └─ depth: brief/normal/full ✅

人浏览 Obsidian
  ├─ 仪表盘 / 流程巡检 / 问题追踪 ✅ (自动刷新)
  ├─ Kanban 管线看板 ✅
  ├─ Dataview 索引聚合 ✅
  ├─ Graph View 知识网络 ⚠️ (无颜色分组)
  ├─ Smart Connections 语义关联 ✅
  └─ Omnisearch BM25 搜索 ✅
```

| 缺失 | 影响 | 优先级 |
|------|------|:--:|
| obs_query 未接入 Smart Connections | ✅ 已修复 — 集成 /search/smart | 🟢 |
| Graph View 无颜色 | 77 节点不易导航 | 🟢 |
| 无"最近更新"便捷入口 | 不知道哪些页面刚被编译 | 🟢 |

---

## 四、性能与效率

### 4.1 启动性能

| 组件 | 估算耗时 | 影响 |
|------|---------|------|
| Obsidian 核心 | ~2s | 正常 |
| 15 插件加载 | ~3-5s | 可接受 |
| Smart Connections 首次索引 | ~10-30s（77 wiki + 43 raw） | 仅首次，后续增量 |
| Omnisearch 缓存 | ~1-2s | 正常 |
| Obsidian Git pull | ~1-5s（取决于网络） | 可接受 |

> 总启动时间：正常 5-8s，首次（Smart Connections 索引）15-35s。可接受。

### 4.2 运行时性能

| 操作 | 影响 |
|------|------|
| agent_end（每次 Pi 回复） | <10ms（内存缓存 O(1) 去重），ingest 异步 |
| before_agent_start（每次 Pi 启动） | 刷新 3 个系统页面，~20-50ms |
| Linter onSave | <100ms per file |
| Obsidian Git auto-commit | 异步后台，不阻塞 |
| auto-note-mover | 仅移动文件时触发 |
| Smart Connections 增量索引 | 后台异步 |

### 4.3 存储增长预估

| 来源 | 增速 | 年估算 |
|------|------|--------|
| raw/sessions/ | ~2-5 篇/天，每篇 ~1KB | ~1-2 MB/年 |
| wiki/ | ~1-3 篇/天 | ~1 MB/年 |
| pi-llm-wiki.log | ~1-3 条/天，rotate 保留 4MB | ~4 MB 稳态 |
| pi-llm-wiki-debug.log | ~10-50 行/天 | ~1 MB/年 |

> 年增长 <10 MB。Vault 15 MB → 25 MB。无压力。

---

## 五、修复清单（按优先级）

### 立即（5 分钟）

| # | 修复 | 位置 |
|---|------|------|
| F1 | Git `showErrorNotices: true` | obsidian-git data.json |
| F2 | Linter `displayChanged: true` | obsidian-linter data.json |
| F3 | Graph View 颜色分组 | graph.json + wiki 标签 |

### 短期（本次会话）

| # | 任务 | 说明 |
|---|------|------|
| F4 | Smart Connections 手动触发初始索引 | 避免首次使用时卡顿 |
| F5 | Dataview 日期格式 + task 跟踪 | 虽然是 0 config 但可优化 |

### 中期（P4 知识进化）— 全部已完成 ✅

| # | 任务 | 状态 |
|---|------|------|
| P-3 | obs_compile 编译前查重 | ✅ src/tools/compile.ts |
| P4.3 | obs_lint 重复内容检测 (Jaccard) | ✅ src/tools/lint.ts + analyzer.ts |
| P4.2 | obs_lint 矛盾检测 | ✅ src/tools/lint.ts + analyzer.ts |
| P-4 | 管线失败恢复 | ✅ src/system/recovery.ts |

### 长期 — 全部已完成 ✅

| # | 任务 | 状态 |
|---|------|------|
| G2 | obs_query 接入 Smart Connections 语义搜索 | ✅ src/tools/query.ts + client.ts |
| P4.1 | 知识升级检测 | ✅ src/system/analyzer.ts (多项目验证) |

---

## 六、冗余消除确认

| 疑似冗余 | 结论 |
|----------|------|
| Omnisearch vs REST API vs Smart Connections | ❌ 非冗余 — 人用 Omnisearch/SC，Agent 用 REST API，三层互补 |
| Auto Note Mover vs pi-llm-wiki 写分类 | ❌ 非冗余 — mover 管"人写的"页面，pi-llm-wiki 管"自动生成"的页面，不冲突 |
| Tag Wrangler vs Auto Note Mover | ❌ 非冗余 — TW 交互式标签管理，ANM 自动规则移页 |
| Tasks vs Kanban | ❌ 非冗余 — Tasks 管"什么时候做"，Kanban 管"做到哪一步" |
| Strange New Worlds vs Graph View | ❌ 非冗余 — SNW 显示引用计数（数字），Graph View 显示网络（图） |

**确认：15 个插件零冗余。**

---

## 七、缺失能力

| 能力 | 当前 | 建议 |
|------|------|------|
| 知识"最近更新"导航 | ❌ | Dataview 查询 `file.mtime` 最近 7 天 |
| 编译失败恢复 | ❌ | P-4 管线失败恢复 |
| Agent 语义搜索 | ⚠️ | G2（待实现） |
| 备份健康监控 | ⚠️ | Git push 失败告警（F1） |
