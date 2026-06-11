/**
 * pi-llm-wiki — obs-compile tool.
 * Compiles raw/sessions/ → wiki/ pages with double-links.
 * Reads a raw session, extracts concepts/decisions/insights, creates a wiki page.
 * Returns linkedTo for obs-weave follow-up.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile, appendToFile } from "../client";
import { markCompiled } from "../manifest";
import { PATHS, WIKI_TYPES, LLM_CONFIG } from "../config";
import { logChange } from "../system/changes";
import { detectProject } from "../project";
import { collectWikiPages, detectKnowledgeUpgrade, textSimilarity } from "../system/analyzer";

const DEDUP_THRESHOLD = 0.3;

// ── Structured section parsing ──

interface StructuredSections {
  goal: string;
  decisions: string[];
  insights: string[];
  issues: string[];
}

/** Parse 🎯/⚖️/💡/⚠️ sections from LLM-extracted body */
function parseStructuredBody(body: string): StructuredSections | null {
  const sections: StructuredSections = { goal: "", decisions: [], insights: [], issues: [] };

  const goalMatch = body.match(/### 🎯 目标\n{1,2}([\s\S]*?)(?=\n### |\n$)/);
  if (goalMatch) sections.goal = goalMatch[1].trim();

  const decisionsMatch = body.match(/### ⚖️ 决策\n{1,2}([\s\S]*?)(?=\n### |\n$)/);
  if (decisionsMatch) {
    sections.decisions = decisionsMatch[1]
      .split("\n").map(l => l.replace(/^- /, "").trim()).filter(Boolean);
  }

  const insightsMatch = body.match(/### 💡 洞察\n{1,2}([\s\S]*?)(?=\n### |\n$)/);
  if (insightsMatch) {
    sections.insights = insightsMatch[1]
      .split("\n").map(l => l.replace(/^- /, "").trim()).filter(Boolean);
  }

  const issuesMatch = body.match(/### ⚠️ 遗留\n{1,2}([\s\S]*?)(?=\n### |\n$)/);
  if (issuesMatch) {
    sections.issues = issuesMatch[1]
      .split("\n").map(l => l.replace(/^- /, "").trim()).filter(Boolean);
  }

  return sections.goal || sections.decisions.length > 0 || sections.insights.length > 0
    ? sections : null;
}

/** Build concise wiki page from structured sections */
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

/** Call GLM-4-Flash to extract structured knowledge from session body */
async function summarizeWithGLM(body: string): Promise<StructuredSections | null> {
  const apiKey = process.env[LLM_CONFIG.keyVar];
  if (!apiKey) return null;

  const prompt = `从以下 AI 编程助手的对话中提取结构化知识。

对话内容：
${body.slice(0, 4000)}

请严格按以下格式输出，不要添加额外说明：

### 🎯 目标
（1-2 句话概括用户目标）

### ⚖️ 决策
- （每个决策一条，没有则写"暂无"）

### 💡 洞察
- （每个发现或教训一条，没有则写"暂无"）

### ⚠️ 遗留
- （每个未解决问题一条，没有则写"暂无"）`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LLM_CONFIG.timeoutMs);

    const res = await fetch(LLM_CONFIG.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: LLM_CONFIG.model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: LLM_CONFIG.maxTokens,
        temperature: 0.3,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      console.error(`[pi-llm-wiki] GLM API error: ${res.status}`);
      return null;
    }

    const data = await res.json() as any;
    const output = data.choices?.[0]?.message?.content || "";
    const parsed = parseStructuredBody(output);
    if (parsed) return parsed;

    // If output has no structured sections, wrap whole output as goal
    return { goal: output.slice(0, 500), decisions: [], insights: [], issues: [] };
  } catch (e: any) {
    if (e.name === "AbortError") {
      console.error(`[pi-llm-wiki] GLM API timeout after ${LLM_CONFIG.timeoutMs}ms`);
    } else {
      console.error(`[pi-llm-wiki] GLM API failed: ${e.message}`);
    }
    return null;
  }
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

  // Extract frontmatter (must happen before projectName uses fmProject)
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return null;

  const frontmatter = fmMatch[1];
  const body = fmMatch[2];

  // Determine project name: frontmatter > detect from cwd > fallback
  const fmProject = frontmatter.match(/project:\s*"?(.+?)"?\s*$/m)?.[1];
  const project = detectProject(ctx.cwd ?? process.cwd());
  const projectName = fmProject ?? project?.name ?? "unknown";

  // Extract title and date from frontmatter
  const titleMatch = frontmatter.match(/title:\s*"?(.+?)"?\s*$/m);
  const title = titleMatch?.[1] ?? rawPath.split("/").pop()!.replace(".md", "");
  const dateMatch = frontmatter.match(/date:\s*(\S+)\s*$/m);
  const date = dateMatch?.[1] ?? new Date().toISOString().split("T")[0];

  // P-3: Pre-compile dedup — check if similar wiki page already exists
  const allPages = collectWikiPages();
  const similar = allPages
    .map((p) => ({ page: p, sim: textSimilarity(title, p.title) }))
    .filter(({ sim }) => sim > DEDUP_THRESHOLD)
    .sort((a, b) => b.sim - a.sim);
  if (similar.length > 0) {
    const top = similar[0];
    return {
      rawPath,
      wikiPath: top.page.path,
      wikiType: top.page.path.split("/")[1] ?? "发现",
      linkedTo: [],
      insights: [],
      dedupSuggestion: `⚠️ 已有相似页面 [[${top.page.path}]] (相似度 ${(top.sim * 100).toFixed(0)}%)，建议使用 obs-weave 织入而非创建新页面。`,
    } as CompileResult;
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

  // Build wiki page content (Phase 6: structured extraction) — try structured sections first
  const structured = parseStructuredBody(body);
  let wikiContent: string;
  let insightLines: string[] = [];

  if (structured) {
    // Path A: body has 🎯⚖️💡⚠️ — use structured content directly
    wikiContent = buildWikiFromStructured(title, structured);
    insightLines = [...structured.decisions, ...structured.insights].slice(0, 5);
  } else if (body.length > 200) {
    // Path B: no structure — try GLM-4-Flash
    const glmResult = await summarizeWithGLM(body);
    if (glmResult) {
      wikiContent = buildWikiFromStructured(title, glmResult);
      insightLines = [...glmResult.decisions, ...glmResult.insights].slice(0, 5);
    } else {
      // GLM failed — fallback to direct copy
      wikiContent = `# ${title}\n\n${body}`;
      insightLines = [];
    }
  } else {
    // Path C: short content, compile directly
    wikiContent = `# ${title}\n\n${body}`;
    insightLines = [];
  }

  // Wrap content in frontmatter
  const links = params.links ?? [];
  const linkLines = links.map((l) => `- [[${l}]]`).join("\n");
  const dateLine = date ? `created: ${date}` : "";

  wikiContent = `---
title: "${title}"
tags: [wiki/${wikiDir}, compiled]
type: "${wikiDir}"
project: "${projectName}"
source: "${rawPath}"
cssclasses: ["${wikiDir}"]
${dateLine}
compiled: ${date}
related: [${links.join(", ")}]
---

${wikiContent}

---

## 🔗 相关链接

${linkLines || "暂无关联"}

> 编译自 [[${rawPath}]]
`;

  await writeFile(wikiPath, wikiContent);

  // Mark raw session as compiled, store pipeline state for recovery
  await markCompiled(rawPath, { compiledTo: wikiPath, linkedTo: links });

  // Mark task as done if raw session has Tasks checkbox
  try {
    const rawContent = await readFile(rawPath);
    if (rawContent.includes("- [ ] 编译:")) {
      const done = rawContent.replace(
        /- \[ \] (编译:.*)/,
        `- [x] $1 ✅ ${date}`
      );
      await writeFile(rawPath, done);
    }
  } catch {
    // non-fatal
  }

  // Update log
  try {
    await appendToFile(
      PATHS.log,
      `## [${date}] compile | ${rawPath} → ${wikiPath}`
    );
  } catch {
    // non-fatal
  }

  // insights already extracted from structured sections above (or empty)
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

    // Inject upgrade callout into the written wiki page
    try {
      const current = await readFile(wikiPath);
      const injected = current.replace(
        "## 🔗 相关链接",
        upgradeNotes.join("\n") + "\n## 🔗 相关链接"
      );
      await writeFile(wikiPath, injected);
    } catch {
      // non-fatal
    }
  }

  // Phase 3: Log change for incremental processing
  logChange({ type: "compile", path: wikiPath, action: "create", timestamp: date, wikiPath });

  return {
    rawPath,
    wikiPath,
    wikiType: wikiDir,
    linkedTo: links,
    insights: insightLines,
    ...(upgrades.length > 0 ? { upgrades: upgrades.map((u) => ({
      insight: u.insight,
      projectCount: u.projectCount,
      suggestedTarget: u.suggestedTarget,
    })) } : {}),
  };
}
