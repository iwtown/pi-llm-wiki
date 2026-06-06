/**
 * pi-llm-wiki — obs-compile tool.
 * Compiles raw/sessions/ → wiki/ pages with double-links.
 * Reads a raw session, extracts concepts/decisions/insights, creates a wiki page.
 * Returns linkedTo for obs-weave follow-up.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile, appendToFile } from "../client";
import { markCompiled } from "../manifest";
import { PATHS, WIKI_TYPES } from "../config";
import { detectProject } from "../project";
import { collectWikiPages, detectKnowledgeUpgrade } from "../system/analyzer";

export interface CompileResult {
  rawPath: string;
  wikiPath: string;
  wikiType: string;
  linkedTo: string[];
  insights: string[];
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
  const links = params.links ?? [];
  const linkLines = links.map((l) => `- [[${l}]]`).join("\n");
  const dateLine = date ? `date: ${date}` : "";

  const wikiContent = `---
title: "${title}"
tags: [${wikiDir.toLowerCase()}, compiled]
type: "${wikiDir}"
project: "${projectName}"
source: "${rawPath}"
${dateLine}
compiled: ${date}
related: [${links.join(", ")}]
---

# ${title}

${body}

---

## 🔗 相关链接

${linkLines || "暂无关联"}

> 编译自 [[${rawPath}]]
`;

  await writeFile(wikiPath, wikiContent);

  // Mark raw session as compiled
  await markCompiled(rawPath);

  // Update log
  try {
    await appendToFile(
      PATHS.log,
      `## [${date}] compile | ${rawPath} → ${wikiPath}`
    );
  } catch {
    // non-fatal
  }

  // Extract insights from body (lines marked with 💡 / 收获 / 洞察)
  const insightLines = body
    .split("\n")
    .filter((line) => /[💡🔍⚠️]|收获|洞察|关键发现|教训/.test(line))
    .map((line) => line.replace(/^[-*#]\s*/, "").trim())
    .filter((line) => line.length > 5)
    .slice(0, 5);

  // P4.1: Detect knowledge upgrade candidates
  const allPages = collectWikiPages();
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
