# Obsidian Vault 配置指南

> pi-llm-wiki 依赖的 Obsidian 插件与配置清单。
> Vault 位置：`D:\DB\Obsidian\LLM-Wiki\`
> 本文档供新环境搭建或排障时参考。

---

## 一、必需插件（直接影响 pi-llm-wiki 功能）

### 1. REST API（`obsidian-api` by `vigeron/swarogan`）

> 提供 HTTP API 供 Pi Agent 读写 vault。

| 项目 | 值 |
|------|------|
| 插件 ID | `rest-api` (注册名)，目录名 `obsidian-api` |
| 端口 | **27124** (HTTPS) |
| API Key | 环境变量 `OBSIDIAN_LLM_WIKI_KEY` |
| 来源 | GitHub release（不在社区商店） |

**配置要点**：
- HTTPS 自签名证书 — `NODE_TLS_REJECT_UNAUTHORIZED=0` 在 `~/.dotfiles.env` 中
- 在 Obsidian 设置中启用后，Ribbon 面板会出现 REST API 图标

**提供端点**（pi-llm-wiki 使用）：
| 端点 | 用途 | 请求格式 |
|------|------|----------|
| `GET /vault/{path}` | 读取文件 | — |
| `PUT /vault/{path}` | 写入文件 | text/markdown body |
| `DELETE /vault/{path}` | 删除文件 | — |
| `GET /vault/{dir}/` | 列出目录 | — |
| `POST /search/simple/` | 全文搜索 | text/plain body |
| `POST /search/smart` | 语义搜索 | JSON `{"query":"...", "limit":N}` |

**历史**：之前使用 `obsidian-local-rest-api`（Adam Coddington），`obsidian-api` 是其超集，已替换。

### 2. Smart Connections

> 提供语义搜索能力（`/search/smart` 端点）。

| 项目 | 值 |
|------|------|
| 社区商店 | 是 |
| 嵌入模型 | **TaylorAI/bge-micro-v2**（本地 ONNX，384 维） |
| 自定义模型 | 可配置 SiliconFlow BGE（需 Pro 插件） |

**索引进度**：
- 文件级：100%
- 块级：后台缓慢推进（本地模型，全库 ~3400 块）
- 首次需在插件设置中点 **Reset data** 触发全量索引

---

## 二、推荐插件（增强工作流）

| 插件 | 用途 | 配置要点 |
|------|------|----------|
| **Omnisearch** | BM25 全文搜索（关键词兜底） | `ribbonIcon: true` |
| **Dataview** | 知识库统计、索引聚合 | `taskCompletionTracking: true` |
| **Kanban** | 编译管线看板 | `lane-width: 220` |
| **obsidian-git** | 自动备份（5min 提交，15min 推送） | `showErrorNotices: true` |
| **Linter** | YAML 格式自动修复 | `lintOnSave: true`, `displayChanged: true` |
| **Templater** | 复盘模板注入 | — |
| **Tasks** | 任务管理 | — |

---

## 三、可选插件（辅助）

| 插件 | 用途 |
|------|------|
| **Auto Note Mover** | 按条件自动移动文件 |
| **Note Refactor** | 笔记拆分 |
| **Tag Wrangler** | 标签管理 |
| **Strange New Worlds** | 嵌入关系可视化 |
| **Floating TOC** | 浮动目录 |
| **Commander** | 自定义命令/按钮 |

---

## 四、环境变量

所有密钥放在 `~/.dotfiles.env`（由 `.bashrc` source，不加入版本控制）：

```bash
# Obsidian API
export OBSIDIAN_LLM_WIKI_KEY="your-obsidian-api-key"
# 自签名证书容错
export NODE_TLS_REJECT_UNAUTHORIZED=0
```

`.env.example` 中有模板。

---

## 五、端口分配

| 端口 | 用途 | 协议 |
|------|------|------|
| 27124 | obsidian-api REST 服务 | HTTPS |
| 27126 | ~~obsidian-local-rest-api~~ (已停用) | HTTP |

---

## 六、新机器搭建步骤

```bash
# 1. 克隆 vault
git clone https://gitee.com/wtown/obsidian.git D:/DB/Obsidian

# 2. 安装 obsidian-api 插件
# 从 https://github.com/vigeron/obsidian-api/releases 下载
# 解压到 D:/DB/Obsidian/LLM-Wiki/.obsidian/plugins/obsidian-api/

# 3. 在 Obsidian 中启用所有社区插件
# 设置 → 社区插件 → 浏览 → 逐个搜索安装

# 4. 配置环境变量
cp ~/.dotfiles/.env.example ~/.dotfiles.env
# 编辑 ~/.dotfiles.env 填写 API key

# 5. 设置 Git 自动备份
# obsidian-git 插件已配置 5min 自动提交 + 15min 自动推送
# SSH key 需提前配置

# 6. 首次索引 Smart Connections
# 插件设置 → Reset data → 等待文件级索引完成
# 块级索引后台自动推进
```
