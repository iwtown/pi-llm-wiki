/**
 * pi-llm-wiki — obs-compile tool.
 * Compiles raw/sessions/ → wiki/ pages with double-links.
 * Reads a raw session, extracts concepts/decisions/insights, creates a wiki page.
 * Returns linkedTo for obs-weave follow-up.
 *
 * GLM extraction: supports retry on 429/503, exponential backoff,
 * env-overridable model/endpoint, and fallback provider chain.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile, appendToFile } from "../client";
import { markCompiled } from "../manifest";
import { PATHS, WIKI_TYPES, LLM_CONFIG, LLM_FALLBACK_CONFIG } from "../config";
import { logChange } from "../system/changes";
import { detectProject } from "../project";
import { collectWikiPages, detectKnowledgeUpgrade, textSimilarity } from "../system/analyzer";
import { dlog, slog } from "../system/log";

const DEDUP_THRESHOLD = 0.3;

// ── LLM API concurrency limiter ──
/** Simple Promise-based semaphore for throttling concurrent API calls */
class Semaphore {
  private max: number;
  private queue: (() => void)[] = [];
  private running = 0;
  constructor(max: number) { this.max = max; }
  async acquire(): Promise<void> {
    if (this.running < this.max) { this.running++; return; }
    return new Promise((resolve) => { this.queue.push(() => { this.running++; resolve(); }); });
  }
  release(): void {
    if (this.queue.length > 0) { this.queue.shift()!(); }
    else { this.running--; }
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try { return await fn(); }
    finally { this.release(); }
  }
}
const llmSemaphore = new Semaphore(LLM_CONFIG.maxConcurrency ?? 3);

// ── Structured section parsing (extended) ──

interface StructuredSections {
  goal: string;
  decisions: string[];
  insights: string[];
  issues: string[];
  summary?: string;      // concise wiki summary
  tags?: string[];       // technology tags
  importance?: number;   // 1-5 importance score
  title?: string;        // LLM-generated semantic title (for Path A2/B)
}

/** Sleep helper for retry backoff */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Filter out "暂无" (meaning "none") placeholders from string arrays */
function filterNone(arr: string[]): string[] {
  return arr.filter((s) => s !== "暂无" && s.trim() !== "");
}

/** Parse 🎯/⚖️/💡/⚠️ sections + ## 摘要 + 🏷️ 标签 from LLM-extracted body */
export function parseStructuredBody(body: string): StructuredSections | null {
  const sections: StructuredSections = { goal: "", decisions: [], insights: [], issues: [] };

  // Summary (## 摘要 — single line after header)
  const summaryMatch = body.match(/## 摘要\n{1,2}(.+?)(?=\n|$)/);
  if (summaryMatch) sections.summary = summaryMatch[1].trim();

  // Tags (### 🏷️ 标签 — comma-separated or bullet list)
  const tagsMatch = body.match(/### 🏷️ 标签\n{1,2}([\s\S]*?)(?=\n### |\n$|$)/);
  if (tagsMatch) {
    sections.tags = tagsMatch[1]
      .split("\n")
      .map((l) => l.replace(/^- /, "").trim())
      .filter(Boolean)
      .flatMap((t) => t.split(/[,，、]/).map((s) => s.trim()))
      .filter(Boolean);
  }

  // Importance (1-5 score, extracted heuristically)
  const importanceMatch = body.match(/(?:重要性|重要程度|优先级)[：:]\s*(\d+)/);
  if (importanceMatch) {
    const score = parseInt(importanceMatch[1], 10);
    if (score >= 1 && score <= 5) sections.importance = score;
  }

  const goalMatch = body.match(/### 🎯 目标\n{1,2}([\s\S]*?)(?=\n### |\n$|$)/);
  if (goalMatch) sections.goal = goalMatch[1].trim();

  const decisionsMatch = body.match(/### ⚖️ 决策\n{1,2}([\s\S]*?)(?=\n### |\n$|$)/);
  if (decisionsMatch) {
    sections.decisions = filterNone(
      decisionsMatch[1].split("\n").map((l) => l.replace(/^- /, "").trim())
    );
  }

  const insightsMatch = body.match(/### 💡 洞察\n{1,2}([\s\S]*?)(?=\n### |\n$|$)/);
  if (insightsMatch) {
    sections.insights = filterNone(
      insightsMatch[1].split("\n").map((l) => l.replace(/^- /, "").trim())
    );
  }

  // Also extract from OM observation sections and variant section names
  // (🔴 关键发现, 🟡 重要观察, 🔵 其他发现, 💡 反思洞察, Focus)
  for (const prefix of ["🔴 关键发现", "🟡 重要观察", "🔵 其他发现", "💡 反思洞察", "Focus"]) {
    const omMatch = body.match(new RegExp(`### ${prefix}\\n{1,2}([\\s\\S]*?)(?=\\n### |\\n$|$)`));
    if (omMatch) {
      const omInsights = filterNone(
        omMatch[1].split("\n").map((l) => l.replace(/^- /, "").trim())
      );
      sections.insights.push(...omInsights);
    }
  }

  const issuesMatch = body.match(/### ⚠️ 遗留\n{1,2}([\s\S]*?)(?=\n### |\n$|$)/);
  if (issuesMatch) {
    sections.issues = filterNone(
      issuesMatch[1].split("\n").map((l) => l.replace(/^- /, "").trim())
    );
  }

  // Filter out question-like items from insights (review criteria, metadata — not reusable knowledge)
  const questionPattern = /^(Are |Is |Does |Do |Should |Can |Will |Would |Could |May |Any |What |Which |How |Why )/i;
  sections.insights = sections.insights.filter((item) => !questionPattern.test(item.trim()));

  return sections.goal || sections.decisions.length > 0 || sections.insights.length > 0
    ? sections : null;
}

/** Known technology keywords for automatic tag extraction from observations */
const TECH_KEYWORDS: Record<string, string[]> = {
  "Pi Agent": ["pi agent", "pi-agent", "pi_agent"],
  "Pi": ["\\bpi\\b"],
  WezTerm: ["wezterm", "wez"],
  tmux: ["tmux"],
  npm: ["\\bnpm\\b"],
  TypeScript: ["typescript", "type script"],
  GLM: ["glm-4", "glm_4", "bigmodel"],
  DeepSeek: ["deepseek", "deep seek"],
  SiliconFlow: ["siliconflow", "silicon flow"],
  Git: ["\\bgit\\b", "github", "gitlab"],
  Docker: ["docker", "container"],
  LLM: ["\\bllm\\b", "大模型", "language model"],
  API: ["\\bapi\\b", "\\bapis\\b", "rest api"],
  Obsidian: ["obsidian", "llm-wiki", "llm_wiki"],
  "VS Code": ["vs code", "vscode", "visual studio code"],
  Bash: ["\\bbash\\b", "shell script"],
  Rust: ["\\brust\\b"],
  Python: ["\\bpython\\b"],
  JSON: ["\\bjson\\b"],
  YAML: ["\\byaml\\b"],
  Markdown: ["markdown", "\\bmd\\b"],
  Node: ["node.js", "nodejs", "\\bnode\\b"],
  Test: ["\\btest\\b", "\\btesting\\b"],
  CI: ["\\bci\\b", "continuous integration"],
  MCP: ["\\bmcp\\b"],
  WebSocket: ["websocket", "web socket"],
  Mermaid: ["mermaid"],
  WSL: ["\\bwsl\\b", "wsl2"],
  Fork: ["forks", "forking", "subagent"],
  Claude: ["claude"],
};

/**
 * Build a dynamic keyword dictionary from existing wiki pages.
 * Uses page titles as tags and their frontmatter tags as matching patterns.
 */
function buildDynamicDict(pages: ReturnType<typeof collectWikiPages>): Record<string, string[]> {
  const dict: Record<string, string[]> = {};
  const skipPrefixes = ["会话复盘", "会话记录", "crash", "💥"];
  for (const page of pages) {
    const title = (page.title || "").trim();
    if (!title || title.length < 4 || skipPrefixes.some((p) => title.startsWith(p))) continue;
    
    // Clean tag name: truncate long titles, strip non-keyword chars
    let tagName = title.replace(/[\[\](){}「」『』《》【】“”'':]/g, "").trim();
    if (tagName.length > 30) {
      const cut = tagName.slice(0, 27).lastIndexOf(" ");
      tagName = (cut > 10 ? tagName.slice(0, cut) : tagName.slice(0, 27)) + "…";
    }
    
    // Use title as matching pattern (whole word in lowercase)
    const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matchPatterns: string[] = [escapeRegex(title.toLowerCase())];
    
    dict[tagName] = matchPatterns;
  }
  return dict;
}

/** Auto-extract technology tags from observation/insight text.
 *  Optionally accepts a dynamic dictionary built from existing wiki page titles.
 */
export function extractTechTags(
  text: string,
  dynamicDict?: Record<string, string[]>,
): string[] {
  const found: string[] = [];
  const lower = text.toLowerCase();
  
  // Match against static keywords
  for (const [tag, patterns] of Object.entries(TECH_KEYWORDS)) {
    for (const pat of patterns) {
      try {
        if (new RegExp(pat, "i").test(lower)) {
          found.push(tag);
          break;
        }
      } catch { /* skip invalid regex */ }
    }
  }
  
  // Match against dynamic dictionary (wiki page titles)
  if (dynamicDict) {
    for (const [tag, patterns] of Object.entries(dynamicDict)) {
      for (const pat of patterns) {
        if (lower.includes(pat)) {
          found.push(tag);
          break;
        }
      }
    }
  }
  
  // Deduplicate and sort
  return [...new Set(found)].sort();
}

/**
 * Parse the unified extract/distill output format.
 * Format:
 *   标题: <semantic title>
 *   摘要: <one-sentence summary>
 *
 *   决策:
 *   - <decision 1>
 *
 *   洞察:
 *   - <insight 1>
 *
 *   遗留:
 *   - <issue 1>
 *
 *   标签: <tag1>, <tag2>
 *
 * All sections are optional. Also handles the OLD format (### 🎯 / ### 💡 etc.)
 * for backward compatibility with cached LLM outputs.
 */
export function parseDistillOutput(output: string): StructuredSections | null {
  const sections: StructuredSections = {
    goal: "", decisions: [], insights: [], issues: [],
    summary: "", tags: [],
  };

  let matched = false;

  // Title
  const titleMatch = output.match(/^标题[:：]\s*(.+?)$/m);
  if (titleMatch) {
    sections.title = titleMatch[1].trim();
    matched = true;
  }

  // Summary
  const summaryMatch = output.match(/^摘要[:：]\s*(.+?)$/m);
  if (summaryMatch) {
    sections.summary = summaryMatch[1].trim();
    matched = true;
  }

  // Decisions (bullet list under "决策:" line)
  const decisionsMatch = output.match(/^决策[:：]\n((?:- .*\n?)*)/m);
  if (decisionsMatch) {
    sections.decisions = filterNone(
      decisionsMatch[1].split("\n").map((l) => l.replace(/^- /, "").trim())
    );
    if (sections.decisions.length > 0) matched = true;
  }

  // Insights (bullet list under "洞察:" line)
  const insightsMatch = output.match(/^洞察[:：]\n((?:- .*\n?)*)/m);
  if (insightsMatch) {
    sections.insights = filterNone(
      insightsMatch[1].split("\n").map((l) => l.replace(/^- /, "").trim())
    );
    if (sections.insights.length > 0) matched = true;
  }

  // Issues/遗留
  const issuesMatch = output.match(/^(?:遗留|待办|问题)[:：]\n((?:- .*\n?)*)/m);
  if (issuesMatch) {
    sections.issues = filterNone(
      issuesMatch[1].split("\n").map((l) => l.replace(/^- /, "").trim())
    );
  }

  // Tags
  const tagsMatch = output.match(/^(?:标签|关键词|Tags?)[:：]\s*(.+?)$/m);
  if (tagsMatch) {
    sections.tags = tagsMatch[1]
      .split(/[,，、]\s*/)
      .map((t) => t.trim())
      .filter(Boolean);
    if (sections.tags.length > 0) matched = true;
  }

  // If no match at all, try falling back to OLD structured-body format (### 🎯 etc.)
  if (!matched) {
    // Extract goal from ### 🎯 or ## 🎯
    const goalMatch = output.match(/^#{2,3}\s*🎯\s*目标\n{1,2}([\s\S]*?)(?=\n#{2,3}\s*|$)/);
    if (goalMatch) {
      sections.goal = goalMatch[1].trim();
      matched = true;
    }
    // Extract decisions from ### ⚖️
    const decMatch = output.match(/^#{2,3}\s*⚖️\s*决策\n{1,2}([\s\S]*?)(?=\n#{2,3}\s*|$)/);
    if (decMatch) {
      sections.decisions = filterNone(
        decMatch[1].split("\n").map((l) => l.replace(/^- /, "").trim())
      );
      if (sections.decisions.length > 0) matched = true;
    }
    // Extract insights from ### 💡 / 🟡 / 🔴 / 🔵 / variants
    for (const emoji of ["💡 洞察", "💡 反思洞察", "🟡 重要观察", "🔴 关键发现", "🔵 其他发现", "Focus"]) {
      const insMatch = output.match(
        new RegExp(`^#{2,3}\\s*${emoji}\\\
{1,2}([\\s\\S]*?)(?=\\\
#{2,3}\\s*|$)`, "m")
      );
      if (insMatch) {
        const items = filterNone(
          insMatch[1].split("\n").map((l) => l.replace(/^- /, "").trim())
        );
        sections.insights.push(...items);
        if (items.length > 0) matched = true;
      }
    }
  }

  // Filter out question-like items from insights (review criteria, not knowledge)
  const qFilter = /^(Are |Is |Does |Do |Should |Can |Will |Would |Could |May |Any |What |Which |How |Why )/i;
  sections.insights = sections.insights.filter((item) => !qFilter.test(item.trim()));

  return matched ? sections : null;
}

/** Build concise wiki page from structured sections */
function buildWikiFromStructured(title: string, s: StructuredSections): string {
  const parts: string[] = [];
  parts.push(`# ${title}`, "");

  // Optional summary paragraph
  if (s.summary) {
    parts.push(s.summary, "");
  }

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

// ── Provider call with retry ──

interface ProviderConfig {
  model: string;
  endpoint: string;
  timeoutMs: number;
  maxTokens: number;
}

/**
 * Call an LLM provider (OpenAI-compatible chat completions API).
 * Retries on 429 (rate limit) and 503 (service unavailable) with exponential backoff.
 * Accepts optional fetchFn for testability (defaults to globalThis.fetch).
 */
export async function callProvider(
  body: string,
  providerCfg: ProviderConfig,
  apiKey: string,
  prompt: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
  retryCfg?: { maxRetries: number; retryBaseDelayMs: number; maxRetryDelayMs: number; minIntervalMs: number },
  temperature?: number,
): Promise<string | null> {
  const maxRetries = retryCfg?.maxRetries ?? LLM_CONFIG.maxRetries;
  const retryBaseDelayMs = retryCfg?.retryBaseDelayMs ?? LLM_CONFIG.retryBaseDelayMs;
  const maxRetryDelayMs = retryCfg?.maxRetryDelayMs ?? LLM_CONFIG.maxRetryDelayMs;
  const minIntervalMs = retryCfg?.minIntervalMs ?? LLM_CONFIG.minIntervalMs;
  const lastError: string[] = [];

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = Math.min(retryBaseDelayMs * Math.pow(2, attempt - 1), maxRetryDelayMs);
      dlog(`Retry ${attempt}/${maxRetries} after ${delay}ms`);
      await sleep(delay);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), providerCfg.timeoutMs);

    try {
      const res = await fetchFn(providerCfg.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: providerCfg.model,
          messages: [{ role: "user", content: prompt }],
          max_tokens: providerCfg.maxTokens,
          temperature: temperature ?? 0.1,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (res.status === 429 || res.status === 503) {
        // Rate limited / overloaded — parse Retry-After header
        const retryAfter = res.headers.get("retry-after");
        let waitMs = retryBaseDelayMs * Math.pow(2, attempt);
        if (retryAfter) {
          const parsed = parseInt(retryAfter, 10);
          if (!isNaN(parsed)) {
            waitMs = Math.min(parsed * 1000, maxRetryDelayMs);
          }
        }
        // Enforce minimum interval between requests
        if (attempt === 0) await sleep(minIntervalMs);
        dlog(`${providerCfg.model} returned ${res.status}, retrying in ${waitMs}ms (attempt ${attempt + 1})`);
        await sleep(waitMs);
        continue;
      }

      if (!res.ok) {
        const msg = `${providerCfg.model} API error: ${res.status}`;
        dlog(`${msg}`);
        lastError.push(msg);
        return null; // non-retryable error
      }

      const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
      const output = data.choices?.[0]?.message?.content || "";

      if (!output) {
        dlog(`${providerCfg.model} returned empty response`);
        return null;
      }

      return output;
    } catch (e: any) {
      clearTimeout(timeout);
      if (e.name === "AbortError") {
        const msg = `${providerCfg.model} timeout after ${providerCfg.timeoutMs}ms (attempt ${attempt + 1})`;
        dlog(`${msg}`);
        lastError.push(msg);
      } else {
        const msg = `${providerCfg.model} fetch failed: ${e.message}`;
        dlog(`${msg}`);
        lastError.push(msg);
      }
      // On last attempt, return null; otherwise the loop retries
      if (attempt >= maxRetries) return null;
    }
  }

  return null;
}

/** Build the extraction prompt for raw/unstructured sessions (Path B) */
function buildPrompt(body: string): string {
  const sliceLen = LLM_CONFIG.contextChars;
  return `你是一个知识提炼专家。从以下 AI 编程助手的对话中提取可复用于未来工作的知识。

## 输入

对话内容：
${body.slice(0, sliceLen)}

## 输出要求

严格按照以下格式输出，不要添加额外说明：

标题: <10字以内的中文标题，概括核心知识贡献>
摘要: <一句话总结可复用知识>

决策:
- <具体决策内容，附上原因>

洞察:
- <可复用的发现或原则>

遗留:
- <未解决的问题>

标签: <标签1>, <标签2>, <标签3>

## 规则
- 标题不要用"会话""对话""记录"开头
- 如果某类别无内容，跳过整行，不要写"暂无"
- 洞察要抽象为通用知识，而非照搬原文
- 标签3-5个中文关键词，从具体到抽象排序`;
}

/** Build the distill prompt for structured-body sessions (Path A2) */
function buildDistillPrompt(body: string): string {
  const sliceLen = LLM_CONFIG.contextChars;
  return `你是一个知识提炼专家。以下是一个 AI 编程助手的会话复盘，已包含结构化观察记录。

请将这些观察提炼为**可复用于未来工作的中文知识**。

## 输入

${body.slice(0, sliceLen)}

## 输出要求

严格按照以下格式输出，不要添加额外说明：

标题: <10字以内的中文标题，概括本次会话的核心知识贡献>
摘要: <一句话总结本次会话产生的可复用知识>

决策:
- <技术选型/配置变更/工具选择，附上原因>

洞察:
- <提炼后的中文洞察，必须是可复用的知识而非原始记录>

遗留:
- <未解决的问题或待探索方向>

标签: <标签1>, <标签2>, <标签3>

## 关键规则

**标题**：从洞察中提炼，体现知识价值。不要"会话复盘""对话记录"。

**洞察**：每条必须是「可复用的知识」。区分两种情况：
  1. 如果观察已经是可复用的技术知识（如 "wezterm.ts exports createForkPane with timeout 10000ms"），直接保留原文无需改写。
  2. 如果观察是位置描述或用户说了什么（如 "User has project at /home/wtown/projects/pi"），提炼为通用规则。
  ❌ User has project at /home/wtown/projects/pi — a Pi Agent monorepo
  ✅ Pi Agent 采用 monorepo 布局，skills 和 extensions 分离管理
  ✅ (直接保留) wezterm.ts 导出 createForkPane(forkCount) 支持超时 10000ms 的 fork 创建

**决策**：一定要包含原因（"选择 X 因为 Y"），不要只有结论。

**跳过错别忽略**：如果某类别无内容，跳过整行，不要写"暂无"。
**直接保留**：如果观察本身已是精炼的技术知识（函数签名、API 接口、配置参数等），直接照搬不要改写。

**标签**：3-5个中文关键词，从具体到抽象排序。例如：Pi Agent, monorepo, 项目管理, 架构设计`;
}

/**
 * Try structured extraction via primary provider → optional fallback → null.
 * Accepts optional fetchFn for testability and optional retryCfg for testing.
 */
/**
 * Try LLM extraction for raw/unstructured sessions (Path B).
 * Uses old-style extract prompt but outputs the unified format.
 */
async function tryExtract(
  body: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
  retryCfg?: { maxRetries: number; retryBaseDelayMs: number; maxRetryDelayMs: number; minIntervalMs: number },
): Promise<StructuredSections | null> {
  const apiKey = process.env[LLM_CONFIG.keyVar];
  if (!apiKey) return null;

  const prompt = buildPrompt(body);

  // Primary provider (with concurrency throttle)
  const raw = await llmSemaphore.run(() => callProvider(body, LLM_CONFIG, apiKey, prompt, fetchFn, retryCfg, LLM_CONFIG.temperature));
  if (raw) {
    const parsed = parseDistillOutput(raw);
    if (parsed) return parsed;
    // Unparseable → wrap as goal
    return { goal: raw.slice(0, 500), decisions: [], insights: [], issues: [] };
  }

  // Fallback provider (DeepSeek official API)
  const fallbackKey = process.env[LLM_FALLBACK_CONFIG.keyVar];
  if (LLM_FALLBACK_CONFIG.model && LLM_FALLBACK_CONFIG.endpoint && fallbackKey) {
    dlog(`Primary extraction failed, trying fallback: ${LLM_FALLBACK_CONFIG.model}`);
    const raw2 = await llmSemaphore.run(() => callProvider(body, LLM_FALLBACK_CONFIG, fallbackKey, prompt, fetchFn, retryCfg, LLM_CONFIG.temperature));
    if (raw2) {
      const parsed = parseDistillOutput(raw2);
      if (parsed) return parsed;
      return { goal: raw2.slice(0, 500), decisions: [], insights: [], issues: [] };
    }
  }

  return null;
}

/**
 * Try LLM distillation for structured-body sessions (Path A2).
 * Distills observations into wiki-quality knowledge + semantic title.
 * Falls back to null → caller uses old Path A (direct copy).
 */
async function tryDistill(
  body: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
  retryCfg?: { maxRetries: number; retryBaseDelayMs: number; maxRetryDelayMs: number; minIntervalMs: number },
): Promise<StructuredSections | null> {
  const apiKey = process.env[LLM_CONFIG.keyVar];
  if (!apiKey) return null;

  const prompt = buildDistillPrompt(body);

  // Primary provider with higher temperature for creative distillation (concurrency throttled)
  const raw = await llmSemaphore.run(() => callProvider(body, LLM_CONFIG, apiKey, prompt, fetchFn, retryCfg, LLM_CONFIG.distillTemperature));
  if (raw) {
    const parsed = parseDistillOutput(raw);
    if (parsed) return parsed;
    // Unparseable → wrap whole output as one insight
    return { goal: "", decisions: [], insights: [raw.slice(0, 300)], issues: [] };
  }

  // Fallback provider (DeepSeek official API)
  const fallbackKey = process.env[LLM_FALLBACK_CONFIG.keyVar];
  if (LLM_FALLBACK_CONFIG.model && LLM_FALLBACK_CONFIG.endpoint && fallbackKey) {
    dlog(`Primary distillation failed, trying fallback: ${LLM_FALLBACK_CONFIG.model}`);
    const raw2 = await llmSemaphore.run(() => callProvider(body, LLM_FALLBACK_CONFIG, fallbackKey, prompt, fetchFn, retryCfg, LLM_CONFIG.distillTemperature));
    if (raw2) {
      const parsed = parseDistillOutput(raw2);
      if (parsed) return parsed;
      return { goal: "", decisions: [], insights: [raw2.slice(0, 300)], issues: [] };
    }
  }

  return null;
}

/** Simple string hash for deterministic short identifiers */
function hashStr(s: string): string {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    const char = s.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(16).slice(0, 8);
}

export interface CompileResult {
  rawPath: string;
  wikiPath: string;
  wikiType: string;
  linkedTo: string[];
  insights: string[];
  dedupSuggestion?: string;
  upgrades?: { insight: string; projectCount: number; suggestedTarget: string }[];
}

export async function compile(
  rawPath: string,
  params: { wikiType?: string; links?: string[] },
  ctx: ExtensionContext
): Promise<CompileResult | null> {
  let content: string;
  try {
    content = await readFile(rawPath);
  } catch {
    return null; // file not found
  }

  // Extract frontmatter
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return null;

  const frontmatter = fmMatch[1];
  const body = fmMatch[2];

  // Determine project name
  const fmProject = frontmatter.match(/project:\s*"?(.+?)"?\s*$/m)?.[1];
  const project = detectProject(ctx.cwd ?? process.cwd());
  const projectName = fmProject ?? project?.name ?? "unknown";

  // Extract and clean title
  const titleMatch = frontmatter.match(/title:\s*"?(.+?)"?\s*$/m);
  const rawTitle = titleMatch?.[1] ?? rawPath.split("/").pop()!.replace(".md", "");

  function cleanCompileTitle(t: string): string {
    let c = t.trim();
    c = c.replace(/ \|.*$/, "");
    c = c.replace(/^[`\s\/]+/, "").replace(/^--+\s*/, "");
    if (/^[0-9a-f]{8,}(?:-[0-9a-f]{4,}){1,}$/i.test(c) ||
        /^[0-9a-f]{20,}$/i.test(c)) {
      c = "会话记录";
    }
    c = c.replace(/^#+\s*/, "");
    if (c.length > 80) {
      const cutoff = c.slice(0, 77).lastIndexOf(" ");
      c = (cutoff > 40 ? c.slice(0, cutoff) : c.slice(0, 77)) + "…";
    }
    return c || "未命名记录";
  }
  const title = cleanCompileTitle(rawTitle);
  const dateMatch = frontmatter.match(/date:\s*(\S+)\s*$/m);
  const date = dateMatch?.[1] ?? new Date().toISOString().split("T")[0];

  // Quality gate: skip low-scoring auto-ingested sessions (score < 50)
  const scoreMatch = frontmatter.match(/session_score:\s*(\d+)/m);
  const sessionScore = scoreMatch ? parseInt(scoreMatch[1], 10) : 0;
  if (sessionScore > 0 && sessionScore < 50) {
    dlog(`Skipping compile: session_score ${sessionScore} < 50 (${rawPath})`);
    await markCompiled(rawPath, { skipped: "low-quality" });
    return {
      rawPath,
      wikiPath: "",
      wikiType: "发现",
      linkedTo: [],
      insights: [],
      dedupSuggestion: `⏭️ Session 评分 ${sessionScore}（<50），跳过编译。评分较低的 session 通常缺乏足够的结构化内容。`,
    } as CompileResult;
  }

  // Pre-compile dedup — strip dates from titles before comparing to avoid false dedup
  // of generic auto-ingest titles like "会话复盘 — 2026-06-12" vs "会话复盘 — 2026-06-06"
  // After stripping dates, skip dedup for generic auto-ingest patterns like "会话复盘 — 2026-06-12"
  const dedupTitle = title.replace(/\d{4}[-:]\d{2}[-:]\d{2}/g, "").replace(/[\s\-\—]+$/g, "").trim();
  const genericPatterns = ["会话复盘", "会话记录", "session"];
  let allPages: ReturnType<typeof collectWikiPages> = [];
  if (!genericPatterns.includes(dedupTitle.replace(/[\s\-\—]+/g, ""))) {
  allPages = collectWikiPages();
  const similar = allPages
    .map((p) => ({
      page: p,
      sim: textSimilarity(dedupTitle, p.title.replace(/\d{4}[-:]\d{2}[-:]\d{2}/g, "").trim()),
    }))
    .filter(({ sim }) => sim > DEDUP_THRESHOLD)
    .sort((a, b) => b.sim - a.sim);
  if (similar.length > 0) {
    const top = similar[0];
    await markCompiled(rawPath, { skipped: "duplicate" });
    return {
      rawPath,
      wikiPath: top.page.path,
      wikiType: top.page.path.split("/")[1] ?? "发现",
      linkedTo: [],
      insights: [],
      dedupSuggestion: `⚠️ 已有相似页面 [[${top.page.path}]] (相似度 ${(top.sim * 100).toFixed(0)}%)，建议使用 obs-weave 织入而非创建新页面。`,
    } as CompileResult;
  }
  }

  // Determine wiki type
  const wikiType = params.wikiType ?? "发现";
  const wikiDir = WIKI_TYPES.includes(wikiType as (typeof WIKI_TYPES)[number])
    ? wikiType
    : "项目";

  // Collect existing wiki pages for auto-linking (only if not already populated by dedup)
  if (allPages.length === 0) allPages = collectWikiPages();

  // finalTitle starts as the cleaned title, may be overridden by LLM
  let finalTitle = title;

  // Generate a deterministic short hash from rawPath to prevent filename collisions
  // when multiple sessions compile to the same title (e.g. 复盘 today).
  const pathHash = hashStr(rawPath);

  // Build wiki page name (use finalTitle — may be LLM-generated)
  // Append pathHash to guarantee unique filenames across all sessions.
  let safeTitle = finalTitle
    // Strip URL-like fragments (both raw and dash-encoded)
    .replace(/https?:\/\/[^\s]+/g, "")
    .replace(/(?:https?|ftp)---+\S+/g, "")   // dash-encoded URLs
    // Illegal chars → dash
    .replace(/[/\\?%*:|"<>]/g, "-")
    // Keep only Chinese, alphanum, dash, underscore
    .replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, "-")
    // Collapse multiple dashes
    .replace(/-{2,}/g, "-")
    // Trim leading/trailing dashes
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  if (!safeTitle || safeTitle.length < 3) safeTitle = "记录";
  const safeName = `${safeTitle}-${pathHash}`;
  const wikiPath =
    wikiDir === "项目"
      ? `wiki/项目/${projectName}/${safeName}.md`
      : `wiki/${wikiDir}/${safeName}.md`;

  // Build wiki page content
  const structured = parseStructuredBody(body);
  let wikiContent: string;
  let insightLines: string[] = [];
  let extractedTags: string[] | undefined;
  let extractedImportance: number | undefined;
  let extractedSummary: string | undefined;
  let compiledBy = "direct-copy";
  let confidence = 2;
  const bodyLen = body.trim().length;

  if (structured && bodyLen > 500) {
    // Path A2: body has structured sections — distill via LLM into wiki-quality
    // knowledge with a semantic title
    const distillResult = await tryDistill(body);
    const hasKnowledge = distillResult && (distillResult.insights.length > 0 || distillResult.decisions.length > 0);
    if (hasKnowledge) {
      extractedSummary = distillResult!.summary;
      extractedTags = distillResult!.tags;
      extractedImportance = distillResult!.importance;
      if (distillResult!.title) finalTitle = distillResult!.title;
      wikiContent = buildWikiFromStructured(finalTitle, distillResult!);
      insightLines = [...distillResult!.decisions, ...distillResult!.insights].slice(0, 5);
      compiledBy = "glm-4-flash";
      confidence = 5;
      slog("distill_success", {
        model: LLM_CONFIG.model,
        insights: distillResult!.insights.length,
        decisions: distillResult!.decisions.length,
        title: finalTitle,
      });
    } else {
      // Fallback: old Path A (direct copy)
      // Empty distillation (LLM returned title/summary but no knowledge) or
      // LLM unavailable — preserve original observations rather than empty page.
      extractedSummary = structured.summary;
      extractedTags = structured.tags;
      extractedImportance = structured.importance;
      wikiContent = buildWikiFromStructured(title, structured);
      insightLines = [...structured.decisions, ...structured.insights].slice(0, 5);
      compiledBy = "structured-body";
      confidence = 4;
      slog("distill_fallback", {
        reason: distillResult ? "empty_knowledge" : "LLM_unavailable",
        bodyLen,
      });
    }
  } else if (structured) {
    // Path A (thin): body has structured sections but <= 500 chars — direct copy
    extractedSummary = structured.summary;
    extractedTags = structured.tags;
    extractedImportance = structured.importance;
    wikiContent = buildWikiFromStructured(title, structured);
    insightLines = [...structured.decisions, ...structured.insights].slice(0, 5);
    compiledBy = "structured-body";
    confidence = 4;
  } else if (bodyLen > 200) {
    // Path B: try LLM extraction with retry + fallback
    const glmResult = await tryExtract(body);
    if (glmResult && (glmResult.insights.length > 0 || glmResult.decisions.length > 0)) {
      extractedSummary = glmResult.summary;
      extractedTags = glmResult.tags;
      extractedImportance = glmResult.importance;
      if (glmResult.title) finalTitle = glmResult.title;
      wikiContent = buildWikiFromStructured(finalTitle, glmResult);
      insightLines = [...glmResult.decisions, ...glmResult.insights].slice(0, 5);
      compiledBy = "glm-4-flash";
      confidence = 5;
      slog("extract_success", {
        model: LLM_CONFIG.model,
        insights: glmResult.insights.length,
        decisions: glmResult.decisions.length,
        title: finalTitle,
      });
    } else {
      // Empty extraction or LLM unavailable — raw copy with preserved body
      const empty = glmResult ? "empty_knowledge" : "LLM_unavailable";
      slog(empty === "empty_knowledge" ? "extract_empty" : "extract_fail", { model: LLM_CONFIG.model, bodyLen });
      wikiContent = `# ${title}\n\n${body}`;
      insightLines = [];
      compiledBy = "raw-copy";
      confidence = 1;
    }
  } else {
    // Path C: short content (< 200 chars)
    wikiContent = `# ${title}\n\n${body}`;
    insightLines = [];
    compiledBy = "direct-copy";
    confidence = 2;
  }

  // Build tags frontmatter — use LLM-generated tags, or auto-extract from observations
  const wikiTag = `wiki/${wikiDir}`;
  let allTags: string[];
  if (extractedTags && extractedTags.length > 0) {
    allTags = [wikiTag, "compiled", ...extractedTags];
    dlog(`Using LLM-extracted tags: [${extractedTags.join(", ")}]`);
  } else {
    // Auto-extract tech tags from insight content for semantic searchability
    // Merge hardcoded dictionary with dynamic tags from existing wiki page titles
    const dynamicDict = buildDynamicDict(allPages);
    const autoTags = extractTechTags(insightLines.join(" ") + " " + body, dynamicDict);
    allTags = [wikiTag, "compiled", ...autoTags];
    if (autoTags.length > 0) dlog(`Auto-extracted tags: [${autoTags.join(", ")}]`);
  }

  // Build frontmatter extras including source tracking
  const fmExtras: string[] = [];
  if (extractedSummary) fmExtras.push(`summary: "${extractedSummary.replace(/"/g, '\\"')}"`);
  if (extractedImportance) fmExtras.push(`extracted_importance: ${extractedImportance}`);
  fmExtras.push(`compiled_by: "${compiledBy}"`);
  fmExtras.push(`confidence: ${confidence}`);
  // quality_score is baseline confidence on creation; query tracking
  // in query.ts will increment it later, and quality assessment can
  // re-derive with decay. This avoids scoreless pages if pipeline
  // quality assessment fails to run.
  fmExtras.push(`quality_score: ${confidence}`);


  // Auto-detect relevant wiki pages from insight content for cross-referencing
  // Only matches against pages with substantive, semantic titles.
  const searchText = (insightLines.join(" ") + " " + allTags.join(" ") + " " + body.slice(0, 800)).toLowerCase();
  const skipPrefixes = ["会话复盘", "会话记录", "crash", "recovery", "崩溃恢复", "💥"];
  const autoLinks: string[] = [];
  for (const page of allPages) {
    if (!page.path.startsWith("wiki/")) continue;
    if (page.path.endsWith("/" + safeName + ".md")) continue; // skip self
    const title = (page.title || "").toLowerCase().replace(/[\u{1F000}-\u{1FFFF}]/gu, "");
    if (!title || title.length < 5) continue;
    // Skip generic auto-compiled or emoji-tagged pages
    if (skipPrefixes.some((g) => page.title?.toLowerCase().startsWith(g))) continue;
    if (searchText.includes(title)) {
      autoLinks.push(page.path);
    }
  }
  // Dedup, limit to top 5
  const seen = new Set(params.links);
  for (const l of autoLinks) { if (!seen.has(l)) { seen.add(l); } }
  const links = [...seen].slice(0, 5);
  const linkLines = links.map((l) => `- [[${l}]]`).join("\n");
  const dateLine = date ? `created: ${date}` : "";

  wikiContent = `---
title: "${finalTitle}"
tags: [${allTags.join(", ")}]
type: "${wikiDir}"
project: "${projectName}"
source: "${rawPath}"
cssclasses: ["${wikiDir}"]
${dateLine}
compiled: ${date}
${fmExtras.join("\n")}
related: [${links.join(", ")}]
---

${wikiContent}

---

## 🔗 相关链接

${linkLines || "暂无关联"}

> 编译自 [[${rawPath}]]
`;

  await writeFile(wikiPath, wikiContent);

  // Mark raw session as compiled
  await markCompiled(rawPath, { compiledTo: wikiPath, linkedTo: links });

  // Mark task checkbox as done
  try {
    const rawContent = await readFile(rawPath);
    if (rawContent.includes("- [ ] 编译:")) {
      const done = rawContent.replace(
        /- \[ \] (编译:.*)/,
        `- [x] $1 ✅ ${date}`
      );
      await writeFile(rawPath, done);
    }
  } catch { /* non-fatal: task checkbox update is best-effort, session still compiled */ }

  // Update log
  try {
    await appendToFile(PATHS.log, `## [${date}] compile | ${rawPath} → ${wikiPath}`);
  } catch { /* non-fatal: log append failure shouldn't block compile */ }

  // P4.1: Detect knowledge upgrade candidates
  const upgrades = detectKnowledgeUpgrade(insightLines, projectName, allPages);
  const upgradeNotes: string[] = [];
  if (upgrades.length > 0) {
    const upgradeText = upgrades
      .map(
        (u) =>
          `- 💡 "${u.insight.slice(0, 80)}..." 已在 **${u.projectCount} 个项目**中出现 (${u.projects.join(", ")})，建议升级为全局[[wiki/${u.suggestedTarget}/|${u.suggestedTarget}]]`
      )
      .join("\n");
    upgradeNotes.push(
      "\n> [!tip] 知识升级建议",
      "> 编译时检测到此 session 中的洞察已跨项目验证：",
      ...upgradeText.split("\n").map((l) => `> ${l}`),
      ""
    );

    try {
      const current = await readFile(wikiPath);
      const injected = current.replace(
        "## 🔗 相关链接",
        upgradeNotes.join("\n") + "\n## 🔗 相关链接"
      );
      await writeFile(wikiPath, injected);
    } catch { /* non-fatal: upgrade callout injection is best-effort */ }
  }

  // Log change
  logChange({
    type: "compile",
    path: wikiPath,
    action: "create",
    timestamp: date,
    wikiPath,
  });

  return {
    rawPath,
    wikiPath,
    wikiType: wikiDir,
    linkedTo: links,
    insights: insightLines,
    ...(upgrades.length > 0
      ? {
          upgrades: upgrades.map((u) => ({
            insight: u.insight,
            projectCount: u.projectCount,
            suggestedTarget: u.suggestedTarget,
          })),
        }
      : {}),
  };
}
