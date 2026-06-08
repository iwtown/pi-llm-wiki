/**
 * pi-llm-wiki — obs-distill tool.
 * Distills 经验日志 (experience logs) from a wiki page.
 * Per schema Rule 7: reads the ## 📋 经验日志 section, consolidates into a
 * narrative summary, then clears the log section.
 *
 * This implements the "收敛式蒸馏" cycle: accumulate -> distill -> reset.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile } from "../client";

export interface DistillResult {
  pagePath: string;
  logCount: number;
  summary: string;
}

const LOG_HEADER = "## 📋 经验日志";
const LOG_PATTERN = /\n## 📋 经验日志\n([\s\S]*?)(?=\n## |\n---\n|$)/;

export async function distill(
  pagePath: string,
  ctx: ExtensionContext
): Promise<DistillResult | null> {
  let content: string;
  try {
    content = await readFile(pagePath);
  } catch {
    return null;
  }

  // Extract experience log entries
  const logMatch = content.match(LOG_PATTERN);
  if (!logMatch) {
    return null; // no log section found
  }

  const logSection = logMatch[1].trim();
  const logLines = logSection
    .split("\n")
    .filter((line) => line.trim().startsWith("- ") || line.trim().startsWith("- ["))
    .map((line) => line.replace(/^-\s*/, "").trim())
    .filter((line) => line.length > 5);

  if (logLines.length === 0) {
    return null; // empty log
  }

  const logCount = logLines.length;

  // Build summary: concatenate unique entries, deduplicate
  const seen = new Set<string>();
  const uniqueLines = logLines.filter((line) => {
    const key = line.slice(0, 60).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const date = new Date().toISOString().split("T")[0];

  // C2 fix: insert distilled summary section before the log, then clear the log
  const summarySection = [
    "",
    "## \u{1F4D6} 蒸馏摘要",
    "",
    "> 自动蒸馏 \u{2014} " + date + " \u{2014} 合并了 " + logCount + " 条经验日志" +
      (logCount !== uniqueLines.length ? " (去重前 " + logCount + " 条)" : ""),
    "",
    ...uniqueLines.map((l) => "- " + l),
    "",
  ].join("\n");

  // Insert summary before the log section, and clear the log
  const summaryAndClear = summarySection + "\n" + LOG_HEADER + "\n\n";

  // Remove old log section content, keep the header, insert summary before it
  const updated = content.replace(
    LOG_PATTERN,
    "\n" + summaryAndClear
  );

  await writeFile(pagePath, updated);

  return {
    pagePath,
    logCount,
    summary: summarySection.trim(),
  };
}
