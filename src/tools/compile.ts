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
import { dlog } from "../system/log";

const DEDUP_THRESHOLD = 0.3;

// ── Structured section parsing (extended) ──

interface StructuredSections {
  goal: string;
  decisions: string[];
  insights: string[];
  issues: string[];
  summary?: string;      // concise wiki summary
  tags?: string[];       // technology tags
  importance?: number;   // 1-5 importance score
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

  // Also extract from OM observation sections (🔴 关键发现, 🟡 重要观察, 🔵 其他发现)
  for (const prefix of ["🔴 关键发现", "🟡 重要观察", "🔵 其他发现"]) {
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

  return sections.goal || sections.decisions.length > 0 || sections.insights.length > 0
    ? sections : null;
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
): Promise<StructuredSections | null> {
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
          temperature: 0.1,
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

      const parsed = parseStructuredBody(output);
      if (parsed) return parsed;

      // Output exists but no structured sections — wrap as goal
      dlog(`${providerCfg.model} returned unstructured output, wrapping as goal`);
      return { goal: output.slice(0, 500), decisions: [], insights: [], issues: [] };
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

/** Build the extraction prompt */
function buildPrompt(body: string): string {
  const sliceLen = LLM_CONFIG.contextChars;
  return `从以下 AI 编程助手的对话中提取知识。

对话内容：
${body.slice(0, sliceLen)}

请严格按以下格式输出，不要添加额外说明：

## 摘要
（一句话概括本次会话的核心主题）

### 🎯 目标
（1-2 句话概括用户目标）

### ⚖️ 决策
- （每个决策一条，没有则写"暂无"）

### 💡 洞察
- （每个发现或教训一条，没有则写"暂无"）

### ⚠️ 遗留
- （每个未解决问题一条，没有则写"暂无"）

### 🏷️ 标签
- 技术栈、项目名、关键词（尽量用中文，3-5 个）`;
}

/**
 * Try structured extraction via primary provider → optional fallback → null.
 * Accepts optional fetchFn for testability and optional retryCfg for testing.
 */
async function tryExtract(
  body: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
  retryCfg?: { maxRetries: number; retryBaseDelayMs: number; maxRetryDelayMs: number; minIntervalMs: number },
): Promise<StructuredSections | null> {
  const apiKey = process.env[LLM_CONFIG.keyVar];
  if (!apiKey) {
    dlog("No API key for primary provider (ZHIPU_API_KEY)");
    return null;
  }

  const prompt = buildPrompt(body);

  // Primary provider (Zhipu / configured)
  const primary = await callProvider(body, LLM_CONFIG, apiKey, prompt, fetchFn, retryCfg);
  if (primary) return primary;

  // Fallback provider if configured
  const fallbackKey = LLM_FALLBACK_CONFIG.model && LLM_FALLBACK_CONFIG.endpoint
    ? process.env[LLM_FALLBACK_CONFIG.keyVar]
    : null;
  if (fallbackKey) {
    dlog(`Primary extraction failed, trying fallback: ${LLM_FALLBACK_CONFIG.model}`);
    const fallback = await callProvider(body, LLM_FALLBACK_CONFIG, fallbackKey, prompt, fetchFn, retryCfg);
    if (fallback) return fallback;
  }

  return null; // both failed → compile will use raw copy
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

  // Build wiki page name
  const safeName =
    title.replace(/[/\\?%*:|"<>]/g, "-").replace(/\s+/g, "-").slice(0, 80) ||
    "untitled";
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

  if (structured) {
    // Path A: body already has 🎯⚖️💡⚠️ sections
    extractedSummary = structured.summary;
    extractedTags = structured.tags;
    extractedImportance = structured.importance;
    wikiContent = buildWikiFromStructured(title, structured);
    insightLines = [...structured.decisions, ...structured.insights].slice(0, 5);
    compiledBy = "structured-body";
    confidence = 4;
  } else if (body.length > 200) {
    // Path B: try LLM extraction with retry + fallback
    const glmResult = await tryExtract(body);
    if (glmResult) {
      extractedSummary = glmResult.summary;
      extractedTags = glmResult.tags;
      extractedImportance = glmResult.importance;
      wikiContent = buildWikiFromStructured(title, glmResult);
      insightLines = [...glmResult.decisions, ...glmResult.insights].slice(0, 5);
      compiledBy = "glm-4-flash";
      confidence = 5;
    } else {
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

  // Build tags frontmatter
  const wikiTag = `wiki/${wikiDir}`;
  const allTags = extractedTags
    ? [wikiTag, "compiled", ...extractedTags]
    : [wikiTag, "compiled"];

  // Build frontmatter extras including source tracking
  const fmExtras: string[] = [];
  if (extractedSummary) fmExtras.push(`summary: "${extractedSummary.replace(/"/g, '\\"')}"`);
  if (extractedImportance) fmExtras.push(`extracted_importance: ${extractedImportance}`);
  fmExtras.push(`compiled_by: "${compiledBy}"`);
  fmExtras.push(`confidence: ${confidence}`);


  const links = params.links ?? [];
  const linkLines = links.map((l) => `- [[${l}]]`).join("\n");
  const dateLine = date ? `created: ${date}` : "";

  wikiContent = `---
title: "${title}"
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
