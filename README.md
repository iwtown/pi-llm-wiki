# pi-llm-wiki

Pi Agent LLM-Wiki 知识管理包。基于 Karpathy LLM Wiki 模式，为 AI Agent 提供 Obsidian 驱动的长期记忆系统。

## 功能

7 个核心工具 + 2 个生命周期钩子：

| 工具 | 功能 |
|------|------|
| `obs_ingest` | 会话复盘 → raw/sessions/（≤500 字） |
| `obs_query` | 搜索知识库（brief/normal/full 三级深度） |
| `obs_compile` | 编译 raw session → wiki 页面 + 双链 |
| `obs_weave` | 织入已有页面，追加经验日志 |
| `obs_lint` | 健康检查（孤立节点、过期内容、断链） |
| `obs_capture` | 查询中发现的关键信息回流 |
| `obs_reference` | 跨库知识引用卡片 |

| 钩子 | 触发点 |
|------|--------|
| `before-start` | 注入 LLM-Wiki Schema 到 system prompt |
| `agent-end` | 会话结束时自动 `obs_ingest` |

## 架构

```
三层模型（Karpathy 原版）
  Raw source (不可变)  →  raw/sessions/ + raw/clippings/
  Draft / 萃取稿          →  raw/sessions/<project>/
  Wiki (编译态)         →  wiki/概念/ 决策/ 命令/ 流程/ 项目/ 发现/
```

## 安装

```bash
# 克隆到 ~/pi-llm-wiki
git clone https://github.com/wtown/pi-llm-wiki.git ~/pi-llm-wiki

# 在 Pi settings.json 中添加本地路径
# "packages": ["../../pi-llm-wiki"]

# 设置环境变量
export OBSIDIAN_LLM_WIKI_KEY="your-key"  # Obsidian REST API 插件密钥
```

## 要求

- Pi Agent ≥ 0.78.0
- Obsidian + REST API 插件
- Node.js ≥ 18

## 开发

```bash
cd ~/pi-llm-wiki
# 修改 src/ 下的 TypeScript 文件
# 重启 Pi 或 /reload 即可生效
```
