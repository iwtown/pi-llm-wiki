# pi-llm-wiki

Pi Agent LLM-Wiki 知识管理包。基于 Karpathy LLM Wiki 模式，为 AI Agent 提供 Obsidian 驱动的长期记忆系统。

## 功能

3 个工具 + 3 个生命周期钩子 + 自动管线：

| 工具 | 功能 |
|------|------|
| `obs_query` | 搜索知识库（brief/normal/full 三级深度） |
| `obs_admin` | 知识管理：capture / reference / aggregate / distill |
| `obs_rate` | 评价 wiki 页面质量（useful / outdated） |

| 钩子 | 触发点 | 功能 |
|------|--------|------|
| `before_agent_start` | 每次会话开始 | 注入 schema 规则 + 📚 知识预览 |
| `agent_end` | 每次会话结束 | 自动复盘摄入（T1 OM → T2 提取 → T3 跳过 trivial） |
| `startup-recovery` | 会话启动 | 自动恢复 stuck 管线状态 |

| 自动管线 | 触发条件 | 功能 |
|----------|----------|------|
| compile | 积累 ≥5 篇 raw session | raw → wiki 编译 |
| weave | compile 后 | 织入已有页面 + 回链 |
| lint | weave 后 | 健康检查 + quality_score 更新 |
| quality | lint 中 | 质量评分 + 自动清理 |

## 架构

```
纯文件系统（无 REST API 依赖）
  Raw session (不可变) → raw/sessions/<project>/
  Wiki (编译态)        → wiki/概念/ 决策/ 命令/ 流程/ 项目/ 发现/
  Quality score        → frontmatter 自动维护
```

## 安装

```bash
# 克隆到 ~/pi-llm-wiki
git clone https://github.com/wtown/pi-llm-wiki.git ~/pi-llm-wiki

# 在 Pi settings.json 中添加
# "packages": ["../../pi-llm-wiki"]
```

## 要求

- Pi Agent ≥ 0.78.0
- Node.js ≥ 18
- Obsidian vault 文件系统可访问（WSL2 直接读写）

## 开发

```bash
cd ~/pi-llm-wiki
# 修改 src/ 下的 TypeScript 文件
# 重启 Pi 或 /reload 即可生效
```
