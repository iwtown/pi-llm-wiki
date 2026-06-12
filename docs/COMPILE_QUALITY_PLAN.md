# 编译质量改进方案 v2

> 基于 v1 方案 + GLM-4-Flash + BGE micro v2 模型适配。
> 49 篇 pending session 已有 LLM 提取的 🎯⚖️💡⚠️ 结构。

---

## 问题

`compile.ts` 当前：

```
raw session body → wiki page body = 直接拷贝（零变换）
insight 提取     → regex /💡|收获|洞察/（命中率低）
分类             → body grep 关键词（不准）
相似度对比       → Jaccard 词重叠（语义无关则漏掉）
```

结果：wiki 页面 = raw session 长拷贝，不是"知识"。

---

## 模型选择

### GLM-4-Flash-250414（LLM 提取）

| 属性 | 值 |
|------|-----|
| Provider | 智谱 AI (open.bigmodel.cn) |
| 价格 | **免费** |
| 中文能力 | 中文原生预训练，优于 DeepSeek |
| 上下文 | 128K |
| 速度 | Flash 系列，低延迟 |

**适用**：compile 时对无结构 session 做 🎯⚖️💡⚠️ 提取。

### TaylorAI/bge-micro-v2（Embedding）

| 属性 | 值 |
|------|-----|
| Provider | Smart Connections 插件（已部署） |
| Vector dims | 384 维 |
| 访问方式 | `POST /search/smart` API（已在 query.ts 中使用） |
| 速度 | 本地 ONNX 推理，毫秒级 |

**适用**：替换所有 Jaccard 相似度计算，实现语义级别的聚类/去重/关联。

---

## 架构改动

```
compile(rawPath) 之前:
  BGE micro v2 → getEmbedding(body) → 聚类 pending sessions
                                      → 语义查重（vs 已有 wiki）
                                      → 关联页面推荐

compile(rawPath) 之中:
  有 🎯⚖️💡⚠️ 结构？ → parseStructuredBody() 提取（零 API）
  无结构且 >200 字？ → GLM-4-Flash 提取 + 编译（1 次 API）
  极短 session？     → 直接编译（零 API）
```

---

## 改动详情

### 1. `src/system/analyzer.ts` — BGE embedding 替代 Jaccard

**当前** `textSimilarity()` 用 Jaccard（词集合重叠度），语义相近但用词不同则无效。

**新增**：

```typescript
/** Get embedding vector via Smart Connections API */
export async function getEmbedding(text: string): Promise<number[] | null> {
  try {
    const res = await apiRequest<{embedding: number[]}>(
      "POST",
      "/search/smart",
      JSON.stringify({ query: text, limit: 1 }),
      "application/json"
    );
    // Smart Connections doesn't expose raw embeddings directly,
    // but we can use the semantic search scores as similarity proxy.
    // For actual embedding access, we use the search results similarity.
    return null; // Fallback: use search-based similarity
  } catch {
    return null;
  }
}

/** Semantic text similarity using Smart Connections */
export async function semanticSimilarity(a: string, b: string): Promise<number> {
  // Use Smart Connections to search a in context of b
  try {
    const results = await smartSearch(a, 5);
    for (const r of results) {
      if (r.path.includes(b.slice(0, 30).replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, ""))) {
        return r.score;
      }
    }
    return 0;
  } catch {
    return textSimilarity(a, b); // fallback to Jaccard
  }
}
```

**实际上 Smart Connections API 的调用方式**：

```typescript
/** Get similarity score between two texts using Smart Connections */
export async function smartSimilarity(a: string, b: string): Promise<number> {
  // Search a, check if b appears in results
  const results = await smartSearch(a, 10);
  // Match by content overlap
  for (const r of results) {
    // Compare text content directly
    const overlap = textSimilarity(r.text.slice(0, 200), b.slice(0, 200));
    if (overlap > 0.3) {
      return r.score;
    }
  }
  return 0;
}
```

**注意**：Smart Connections API 不直接暴露原始 embedding 向量，它只返回"query → ranked results"。但我们可以通过以下方式间接利用 BGE 的语义能力：

| 需求 | 做法 | 使用 BGE? |
|------|------|-----------|
| 两个文本的相似度 | 用 A 搜 B 的排名分数 | ✅ 间接 |
| session 聚类 | 对 pending sessions 两两计算相似度→分组 | ✅ |
| 编译查重 | 对比新 session 与已有 wiki 的相似度 | ✅ |
| 知识升级检测 | 跨项目查 insight 相似度 | ✅ |

### 2. `src/tools/compile.ts` — 编译路径重构

#### 2.1 新增 parseStructuredBody()

```typescript
interface StructuredSections {
  goal: string;
  decisions: string[];
  insights: string[];
  issues: string[];
}

/** Parse 🎯/⚖️/💡/⚠️ sections from LLM-extracted body */
function parseStructuredBody(body: string): StructuredSections | null {
  const sections: StructuredSections = { goal: "", decisions: [], insights: [], issues: [] };

  const goalMatch = body.match(/### 🎯 目标\n\n([\s\S]*?)(?=\n### |\n$)/);
  if (goalMatch) sections.goal = goalMatch[1].trim();

  const decisionsMatch = body.match(/### ⚖️ 决策\n\n([\s\S]*?)(?=\n### |\n$)/);
  if (decisionsMatch) {
    sections.decisions = decisionsMatch[1]
      .split("\n").map(l => l.replace(/^- /, "").trim()).filter(Boolean);
  }

  const insightsMatch = body.match(/### 💡 洞察\n\n([\s\S]*?)(?=\n### |\n$)/);
  if (insightsMatch) {
    sections.insights = insightsMatch[1]
      .split("\n").map(l => l.replace(/^- /, "").trim()).filter(Boolean);
  }

  const issuesMatch = body.match(/### ⚠️ 遗留\n\n([\s\S]*?)(?=\n### |\n$)/);
  if (issuesMatch) {
    sections.issues = issuesMatch[1]
      .split("\n").map(l => l.replace(/^- /, "").trim()).filter(Boolean);
  }

  return sections.goal || sections.decisions.length > 0 || sections.insights.length > 0
    ? sections : null;
}
```

#### 2.2 新增 summarizeWithGLM()

```typescript
const GLM_ENDPOINT = "https://open.bigmodel.cn/api/paas/v4/chat/completions";

async function summarizeWithGLM(body: string): Promise<StructuredSections | null> {
  const apiKey = process.env.ZHIPU_API_KEY;
  if (!apiKey) return null;

  const prompt = `从以下 AI 编程助手的对话中提取结构化知识。对话内容：

${body.slice(0, 4000)}

请用以下格式输出：

### 🎯 目标
（1-2 句话概括用户目标）

### ⚖️ 决策
- （每个决策一条）
- （如果没有则写"暂无"）

### 💡 洞察
- （每个发现或教训一条）
- （如果没有则写"暂无"）

### ⚠️ 遗留
- （每个未解决问题一条）
- （如果没有则写"暂无"）

注意：
- 使用中文
- 每条决策/洞察/遗留用 "- " 开头
- 不要添加额外解释`;

  try {
    const res = await fetch(GLM_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "glm-4-flash",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 1000,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      console.error(`[pi-llm-wiki] GLM API error: ${res.status}`);
      return null;
    }

    const data = await res.json() as any;
    const output = data.choices?.[0]?.message?.content || "";
    return parseStructuredBody(output);
  } catch (e: any) {
    console.error(`[pi-llm-wiki] GLM API failed: ${e.message}`);
    return null;
  }
}
```

#### 2.3 新增 buildWikiFromStructured()

```typescript
function buildWikiFromStructured(title: string, s: StructuredSections): string {
  const parts: string[] = [];

  parts.push(`# ${title}`, "");
  parts.push("## 🎯 目标", "");
  parts.push(s.goal || "（无明确目标）", "");

  if (s.decisions.length > 0) {
    parts.push("", "## ⚖️ 决策", "");
    for (const d of s.decisions) parts.push(`- ${d}`);
  }

  if (s.insights.length > 0) {
    parts.push("", "## 💡 洞察", "");
    for (const i of s.insights) parts.push(`- ${i}`);
  }

  if (s.issues.length > 0) {
    parts.push("", "## ⚠️ 遗留", "");
    for (const i of s.issues) parts.push(`- ${i}`);
  }

  return parts.join("\n");
}
```

#### 2.4 重构 compile() 主逻辑

```typescript
// 在 compile() 中找到 body 之后：

const structured = parseStructuredBody(body);

if (structured) {
  // Path A: body has 🎯⚖️💡⚠️ — extract directly
  wikiContent = buildWikiFromStructured(title, structured);
  insightLines = [...structured.decisions, ...structured.insights].slice(0, 5);
} else if (body.length > 200) {
  // Path B: no structure — try GLM-4-Flash
  const glmResult = await summarizeWithGLM(body);
  if (glmResult) {
    wikiContent = buildWikiFromStructured(title, glmResult);
    insightLines = [...glmResult.decisions, ...glmResult.insights].slice(0, 5);
  } else {
    // GLM failed — fallback to direct compile
    wikiContent = `# ${title}\n\n${body}`;
    insightLines = [];
  }
} else {
  // Path C: short content
  wikiContent = `# ${title}\n\n${body}`;
  insightLines = [];
}
```

#### 2.5 删除旧 regex insight 提取

删除：
```typescript
const insightLines = body
  .split("\n")
  .filter((line) => /[💡🔍⚠️]|收获|洞察|关键发现|教训/.test(line))
  ...
```

替换为：
```typescript
// insights now come from structured sections (or empty if none)
```

### 3. `src/tools/compile.ts` — compile 前 BGE 聚类

在 compile 的 for 循环之前，对 pending sessions 做 BGE 语义聚类：

```typescript
/** Group pending sessions by semantic similarity for potential merging */
async function clusterPendingSessions(
  pending: string[], ctx: ExtensionContext
): Promise<Map<string, string[]>> {
  const clusters = new Map<string, string[]>();
  const { smartSearch } = await import("../client");

  // Use first pending session's topic to seed clusters
  for (const rawPath of pending) {
    const content = await readFile(rawPath);
    const fm = extractFrontmatter(content);
    const title = String(fm.title ?? "");

    // Search for similar existing sessions
    const similar = await smartSearch(title, 3);
    let placed = false;
    for (const s of similar) {
      if (s.score > 0.7) {
        // Add to existing cluster
        const existing = clusters.get(s.path) || [];
        existing.push(rawPath);
        clusters.set(s.path, existing);
        placed = true;
        break;
      }
    }
    if (!placed) {
      clusters.set(rawPath, [rawPath]);
    }
  }

  return clusters;
}
```

注意：聚类结果是编译顺序的建议，而非强制合并。同一聚类的 session 可以：
- 编译为单独页面，互相添加双链
- 或由 LLM 合并为一篇综合页面（较复杂，v2 不做）

### 4. 配置

**新增 `src/config.ts`**：

```typescript
export const LLM_CONFIG = {
  /** Model for structured extraction during compile */
  compile_model: "glm-4-flash",
  compile_endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
  /** API key env var name */
  compile_key_var: "ZHIPU_API_KEY",
  /** Timeout for LLM calls during compile */
  compile_timeout_ms: 15_000,
  /** Use BGE semantic similarity in analyzer */
  use_semantic_similarity: true,
} as const;
```

---

## 文件改动汇总

| 文件 | 改动 | 风险 |
|------|------|------|
| `src/config.ts` | 新增 `LLM_CONFIG` 常量 | 低 |
| `src/system/analyzer.ts` | 新增 `smartSimilarity()`，BGE 语义对比替代/补充 Jaccard | 中 |
| `src/tools/compile.ts` | 重构编译逻辑：parseStructuredBody + summarizeWithGLM + buildWikiFromStructured | 中 |
| `src/client.ts` | 可选：暴露 embedding API（如 Smart Connections 支持） | 低 |

---

## 实施步骤

### Step 1: config.ts — 新增 LLM_CONFIG (0.5h)

### Step 2: analyzer.ts — 新增 smartSimilarity() (1h)

通过 Smart Connections API 实现语义相似度。当前 `smartSearch()` 已在 query.ts 中可用。

### Step 3: compile.ts — parseStructuredBody + buildWikiFromStructured (1h)

解析已有 🎯⚖️💡⚠️ 结构的 body。49 篇 pending session 走这条路。

### Step 4: compile.ts — summarizeWithGLM (1.5h)

对无结构 session 调用 GLM-4-Flash。需：
- `ZHIPU_API_KEY` 环境变量
- 15 秒 timeout
- API 失败时降级到直接编译

### Step 5: compile.ts — 替换 insight 提取 + 聚类 (1h)

删除旧 regex，用结构化 sections；可选加 BGE 聚类。

### Step 6: 验证 (1h)

```bash
cd ~/pi-llm-wiki
npx tsc --noEmit
LLM_WIKI_TEST_VAULT=/tmp/test-vault npx tsx --test tests/*.test.ts

# 手动测试对一篇 session 运行 compile
# 检查 wiki 页面内容是否结构化
```

**总计：约 6h**

---

## 风险和缓解

| 风险 | 缓解 |
|------|------|
| `ZHIPU_API_KEY` 未设置 | `summarizeWithGLM()` 返回 null，降级到直接编译 |
| GLM API 超时/失败 | 15 秒 timeout + try/catch 降级 |
| Smart Connections 不可用 | `smartSimilarity()` 回退到 Jaccard |
| BGE 聚类导致 session 丢失 | 聚类是建议性的，不强制合并 |
| 已编译 session 被重新处理 | compile() 入口检查 status !== 'pending' |

---

## 预期效果

| 指标 | 当前 | 改进后 |
|------|------|--------|
| wiki 页内容 | raw body 直接拷贝 | 结构化摘要（🎯⚖️💡⚠️） |
| insight 提取 | regex `/💡\|收获\|洞察/` | 从结构化章节直接提取 |
| 文本相似度 | Jaccard 词重叠 | BGE 语义相似度 |
| 无结构 session | body 拷贝 | GLM 自动提取 + 编译 |
| 知识点发现 | 几乎不触发 | 语义匹配更准 |
| 跨 session 关联 | 无 | BGE 聚类推荐 |

---

## 环境变量

```bash
# 在 ~/.dotfiles.env 中添加（已有 DEEPSEEK_API_KEY 旁边）
export ZHIPU_API_KEY="your-zhipu-api-key"
```
