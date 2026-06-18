# pi-llm-wiki

Pi Agent LLM-Wiki 知识管理包。基于 Karpathy LLM Wiki 模式，为 AI Agent 提供 Obsidian 驱动的长期记忆系统。

3 个工具 + 3 个生命周期钩子 + 自动管线，零 REST API 依赖，纯文件系统操作。

## 安装

```bash
# 方式一：本地路径（dotfiles 场景）
git clone https://github.com/iwtown/pi-llm-wiki.git ~/pi-llm-wiki
# 在 Pi settings.json 中添加 "packages": ["../../pi-llm-wiki"]

# 方式二：npm（如果已发布）
# pi install npm:pi-llm-wiki
```

**要求**: Pi Agent ≥ 0.78.0, Node.js ≥ 18, 可访问的 Obsidian vault 目录

## 功能

### 工具（Agent 可调用）

| 工具 | 功能 |
|------|------|
| `obs_query` | 搜索知识库（brief/normal/full 三级深度） |
| `obs_admin` | 知识管理：capture / reference / aggregate / distill |
| `obs_rate` | 评价 wiki 页面质量（useful / outdated） |

### 生命周期钩子（自动触发）

| 钩子 | 触发点 | 功能 |
|------|--------|------|
| `before_agent_start` | 每次会话开始 | 注入 schema 规则 + 📚 知识预览 |
| `agent_end` | 每次会话结束 | 自动复盘摄入（T1 OM → T2 提取 → T3 跳过 trivial） |
| `startup-recovery` | 会话启动 | 自动恢复 stuck 管线状态 + 崩溃 session 补录 |

### 自动管线

| 管线 | 触发时机 | 功能 |
|------|----------|------|
| compile | `agent_end` ingest 成功 → fire-and-forget | raw → wiki 编译 |
| weave | compile 成功后异步跟随 | 织入已有页面 + 回链 |
| lint | 手动 (`npm run pipeline`) | 全库健康检查 + quality_score 更新 |
| quality | lint 中 | 质量评分 + 自动清理空壳 stale 页 |

## 架构

```
纯文件系统（无 REST API 依赖）

Agent 会话
  │
  ├─ before_agent_start → 注入 schema + 知识预览
  ├─ agent 运行中       → obs_query / obs_admin / obs_rate
  └─ agent_end          → 自动复盘摄入
         │
         ├─ ingest (同步) → raw/sessions/<project>/
         ├─ compile (fire-and-forget) → wiki/概念/发现/决策/...
         └─ weave  (fire-and-forget) → 跨页面回链
```

## 配置

所有配置通过环境变量覆盖。默认值适配 wtown 的 WSL2 环境。完整列表见 [.env.example](.env.example)。

### 核心配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `LLM_WIKI_VAULT` | `/mnt/d/DB/Obsidian/LLM-Wiki` | Obsidian vault 路径 |
| `LLM_WIKI_ZINBOX` | `/mnt/d/DB/Obsidian/ZInBox` | 外部剪藏库路径（搜索用） |

### 主 LLM（GLM 系列）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ZHIPU_API_KEY` | — | API 密钥（必填） |
| `LLM_WIKI_EXTRACT_MODEL` | `glm-4-flash-250414` | 模型 ID |
| `LLM_WIKI_EXTRACT_ENDPOINT` | `https://open.bigmodel.cn/api/paas/v4/chat/completions` | API 端点 |
| `LLM_WIKI_EXTRACT_TIMEOUT_MS` | `15000` | 超时（毫秒） |
| `LLM_WIKI_EXTRACT_MAX_TOKENS` | `1000` | 最大输出 token |
| `LLM_WIKI_EXTRACT_TEMPERATURE` | `0.1` | 采样温度 |
| `LLM_WIKI_MAX_CONCURRENCY` | `3` | 批量请求并发数 |

### 备用 LLM（DeepSeek，主 LLM 拥塞时自动降级）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DEEPSEEK_API_KEY` | — | API 密钥 |
| `LLM_WIKI_FALLBACK_MODEL` | `deepseek-v4-flash` | 模型 ID |
| `LLM_WIKI_FALLBACK_ENDPOINT` | `https://api.deepseek.com/v1/chat/completions` | API 端点 |

> `LLM_WIKI_TEST_VAULT` 和 `LLM_WIKI_TEST_ZINBOX` 作为向后兼容保留。

## 开发

```bash
cd ~/pi-llm-wiki

# 测试
npm test              # 单元测试
npm run test:all      # 全部测试（含管线集成）

# 手动批处理（后备，通常不需要——管线自动运行）
npm run pipeline:dry  # dry-run 模式
npm run pipeline      # 执行全量批处理 + lint
npm run lint          # 仅全库健康检查

# 修改 src/ 下的 TypeScript 文件
# 重启 Pi 或 /reload 即可生效
```

## 包结构

```
pi-llm-wiki/
├── extensions/index.ts   ← Pi Package 入口（注册 3 工具 + 3 钩子）
├── src/                  ← 内部模块
│   ├── hooks/            ← before_agent_start / agent_end / startup-recovery
│   ├── tools/            ← 工具实现 + 管线步骤
│   ├── system/           ← 基础设施（解析、日志、分析、刷新）
│   ├── client.ts         ← 文件系统抽象层
│   ├── config.ts         ← 单一配置真相源
│   └── manifest.ts       ← 管线状态管理
├── scripts/              ← 管线调试脚本
├── tests/                ← 测试（40+，含单元 + 集成 + 钩子）
└── package.json          ← pi 清单
```

## 许可

MIT License. 参见 [LICENSE](LICENSE)。
