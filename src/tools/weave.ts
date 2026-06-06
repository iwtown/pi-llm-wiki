/**
 * pi-llm-wiki — obs-weave tool.
 * After compilation, updates existing wiki pages with backlinks and experience log entries.
 * Reads pages listed in linkedTo, appends new insights/logs, adds backlinks.
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

  // Mark raw session as weaved
  try {
    await markWeaved(rawPath);
  } catch {
    // non-fatal
  }

  return { updatedPages, errors };
}
