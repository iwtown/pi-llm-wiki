/**
 * pi-llm-wiki — obs-aggregate tool.
 * Aggregates compiled wiki pages from a quarter into wiki/记忆/YYYY/Qn.md.
 * Per schema §7.2: quarterly精华提取 from compiled sessions.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile } from "../client";
import { PATHS } from "../config";
import * as fs from "node:fs";
import * as path from "node:path";
import { LLM_WIKI } from "../config";
import { collectWikiPages, type WikiPage } from "../system/analyzer";
import { parseFrontmatter } from "../system/parse";

const VAULT = LLM_WIKI.vault;

interface AggregateParams {
  /** Year, e.g. 2026 */
  year: number;
  /** Quarter: 1-4 */
  quarter: number;
  /** Optional: specific project to aggregate */
  project?: string;
}

interface AggregateResult {
  outputPath: string;
  pageCount: number;
  keyThemes: string[];
}

export async function aggregate(
  params: AggregateParams,
  ctx: ExtensionContext
): Promise<AggregateResult | null> {
  const { year, quarter } = params;
  const qTag = `Q${quarter}`;
  const outputDir = `wiki/记忆/${year}`;
  const outputPath = `${outputDir}/${qTag}.md`;
  const now = new Date().toISOString().split("T")[0];

  // Collect compiled wiki pages
  const allPages = collectWikiPages();
  const compiled = allPages.filter((p) => {
    const fm = parseFrontmatter(p.content);
    const pageDate = fm.date || fm.compiled;
    if (!pageDate) return false;
    const d = new Date(pageDate as string);
    const qMonth = (quarter - 1) * 3 + 2; // middle month of quarter
    return (
      d.getFullYear() === year &&
      Math.floor(d.getMonth() / 3) === quarter - 1
    );
  });

  // Filter by project if specified
  const filtered = params.project
    ? compiled.filter((p) => p.project === params.project)
    : compiled;

  if (filtered.length === 0) {
    return null;
  }

  // Extract key themes: collect all insight-like lines
  const themes = new Map<string, number>();
  for (const page of filtered) {
    const insightLines = page.body
      .split("\n")
      .filter((line) => /[💡🔍⚠️]|收获|洞察|关键发现|教训/.test(line) || line.startsWith("- "))
      .map((line) => line.replace(/^[-*#>\s]+/, "").trim())
      .filter((line) => line.length > 10 && line.length < 200);

    for (const line of insightLines) {
      const key = line.slice(0, 60);
      themes.set(key, (themes.get(key) ?? 0) + 1);
    }
  }

  // Top themes
  const topThemes = [...themes.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([theme, count]) => theme);

  // Build page list
  const pageList = filtered
    .slice(0, 30)
    .map((p) => `- [[${p.path}|${p.title}]]`);

  const content = [
    "---",
    `title: "${year} ${qTag} 季度精华"`,
    `tags: [memory, quarterly, ${year}, ${qTag.toLowerCase()}]`,
    `date: ${now}`,
    `pageCount: ${filtered.length}`,
    "---",
    "",
    `# ${year} ${qTag} 知识精华`,
    "",
    `> 自动聚合 — ${now}  — 共 ${filtered.length} 个编译页面`,
    "",
    "## 🔑 关键主题",
    "",
    ...topThemes.map((t) => `- ${t}`),
    "",
    "## 📄 来源页面",
    "",
    ...pageList.slice(0, 30),
    filtered.length > 30
      ? `- ... 还有 ${filtered.length - 30} 个页面`
      : "",
    "",
    "## 📊 统计",
    "",
    `| 指标 | 值 |`,
    `|------|------|`,
    `| 编译页面 | ${filtered.length} |`,
    `| 提取主题 | ${topThemes.length} |`,
  ].join("\n");

  await writeFile(outputPath, content);

  return {
    outputPath,
    pageCount: filtered.length,
    keyThemes: topThemes,
  };
}


