/**
 * pi-llm-wiki — obs-weave tool.
 * After compilation, updates existing wiki pages with backlinks and experience log entries.
 * Reads pages listed in linkedTo, appends new insights/logs, adds backlinks.
 * Also auto-updates wiki/图谱.md with the new wiki page.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile } from "../client";
import { markWeaved } from "../manifest";
import { PATHS } from "../config";

export interface WeaveResult {
  updatedPages: string[];
  errors: string[];
}

export async function weave(
  rawPath: string,
  wikiPath: string,
  linkedTo: string[],
  insights: string[],
  ctx: ExtensionContext
): Promise<WeaveResult> {
  const updatedPages: string[] = [];
  const errors: string[] = [];

  // Update each linked page with a backlink and log entry
  for (const targetPath of linkedTo) {
    try {
      const content = await readFile(targetPath);
      let updated = content;

      // Add experience log section if it doesn't exist
      if (!content.includes("## 📋 经验日志")) {
        updated += "\n\n## 📋 经验日志\n\n";
      }

      // Append log entry
      const date = new Date().toISOString().split("T")[0];
      const logEntry = `- [${date}] 关联 [[${wikiPath}]] — 编译自 [[${rawPath}]]`;
      if (!content.includes(`[[${wikiPath}]]`)) {
        updated = updated.replace(
          /(## 📋 经验日志\n)/,
          `$1${logEntry}\n`
        );
      }

      // Add backlink in related section if not present
      if (!content.includes(`[[${wikiPath}]]`) && !content.includes(`:\n\n---`)) {
        const backlink = `\n- [[${wikiPath}]]`;
        if (content.includes("## 🔗 相关链接")) {
          updated = updated.replace(/## 🔗 相关链接(\n[-\s\S]*?)(\n\n|---|\n##)/, `## 🔗 相关链接$1${backlink}$2`);
        }
      }

      await writeFile(targetPath, updated);
      updatedPages.push(targetPath);
    } catch (e: any) {
      errors.push(`${targetPath}: ${e.message}`);
    }
  }

  // Update the new wiki page with backlinks to linkedTo pages
  try {
    let wikiContent = await readFile(wikiPath);
    const backlinks = linkedTo.map((p) => `\n- [[${p}]]`).join("");
    if (!wikiContent.includes("## 🔗 相关链接")) {
      wikiContent += `\n\n## 🔗 相关链接\n${backlinks}\n`;
    }
    await writeFile(wikiPath, wikiContent);
  } catch (e: any) {
    errors.push(`${wikiPath} (backlinks): ${e.message}`);
  }

  // Auto-update 图谱.md with the new wiki page
  try {
    await updateAtlas(wikiPath);
  } catch (e: any) {
    errors.push(`${PATHS.index} (atlas): ${e.message}`);
  }

  // Mark raw session as weaved
  try {
    await markWeaved(rawPath);
  } catch {
    // non-fatal
  }

  return { updatedPages, errors };
}

// ── 图谱 update ────────────────────────────────────────────

/** Maps wiki directory to 图谱.md section heading */
const ATLAS_SECTIONS: Record<string, string> = {
  "wiki/概念": "## 📐 概念",
  "wiki/决策": "## ⚖️ 决策（ADR）",
  "wiki/命令": "## 🛠 命令",
  "wiki/流程": "## 🔄 流程（SOP）",
  "wiki/项目": "## 📦 项目",
  "wiki/发现": "## 💡 发现",
  "wiki/记忆": "## 📝 记忆",
  "wiki/索引": "## 📊 索引",
  "wiki/引用": "## 📎 引用",
  "wiki/规则": "## 📏 规则",
};

/** Extract a brief description from wiki page content (first sentence of body) */
function extractDescription(content: string): string {
  // Skip frontmatter
  const bodyMatch = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  if (!bodyMatch) return "";
  const body = bodyMatch[1].trim();
  // Get first meaningful line (skip headings, blank lines)
  const lines = body.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    // Take first sentence or up to 50 chars
    const firstSentence = trimmed.split(/[。.！!]/)[0];
    return firstSentence.slice(0, 50);
  }
  return "";
}

/** Update wiki/图谱.md with a new wiki page if not already listed */
async function updateAtlas(wikiPath: string): Promise<void> {
  const atlasContent = await readFile(PATHS.index);

  // Determine which section this page belongs to
  // wikiPath format: "wiki/概念/foo.md" → dir = "wiki/概念"
  const pathParts = wikiPath.split("/");
  const dir = pathParts.slice(0, 2).join("/"); // e.g. "wiki/概念"
  const sectionHeading = ATLAS_SECTIONS[dir];
  if (!sectionHeading) return; // unknown type, don't update

  // Check if the page is already listed
  const pageLink = `[[${wikiPath.replace(".md", "")}]]`;
  if (atlasContent.includes(pageLink)) return; // already there

  // Read the new wiki page for a brief description
  let description = "";
  try {
    const pageContent = await readFile(wikiPath);
    description = extractDescription(pageContent);
  } catch {
    // page not readable, insert without description
  }

  // Find the section heading and insert after it
  const sectionIndex = atlasContent.indexOf(sectionHeading);
  if (sectionIndex === -1) {
    // Section doesn't exist yet, create it at the end
    const updated =
      atlasContent.trimEnd() +
      `\n\n${sectionHeading}\n\n- ${pageLink}${description ? ` — ${description}` : ""}\n`;
    await writeFile(PATHS.index, updated);
    return;
  }

  // Find the end of this section (next ## heading or end of file)
  const afterHeading = atlasContent.slice(sectionIndex);
  const nextHeading = afterHeading.slice(sectionHeading.length).match(/\n## /);
  let insertIndex: number;
  if (nextHeading && nextHeading.index !== undefined) {
    insertIndex = sectionIndex + sectionHeading.length + nextHeading.index!;
  } else {
    insertIndex = atlasContent.length;
  }

  // Insert the new bullet before the next section or at end
  const bullet = `\n- ${pageLink}${description ? ` — ${description}` : ""}`;
  const updated =
    atlasContent.slice(0, insertIndex) + bullet + atlasContent.slice(insertIndex);
  await writeFile(PATHS.index, updated);
}
