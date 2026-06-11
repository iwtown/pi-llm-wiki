/**
 * pi-llm-wiki — Pipeline recovery module (P-4).
 * Detects sessions stuck in intermediate pipeline states (compiled but not weaved/linted)
 * and re-attempts recovery by re-weaving from the stored wiki page backlinks.
 *
 * Integration points:
 * - src/tools/lint.ts: reports stuck sessions as warnings
 * - src/system/refresh.ts: auto-recovery on startup
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile } from "../client";
import { markWeaved, markLinted, getStuckSessions } from "../manifest";
import { PATHS } from "../config";
import { dlog } from "../system/log";

export interface RecoveryResult {
  recovered: number;
  skipped: number;
  errors: string[];
  details: Array<{
    sessionPath: string;
    action: "re-weaved" | "re-linted" | "skipped_no_target" | "error";
    message: string;
  }>;
}

/**
 * Scan for stuck sessions and attempt pipeline recovery.
 * Session is "stuck" if compiled (status=compiled/woven or compiled=true) but not yet woven (status=woven or weaved=true)
 * or linted (status=done or linted=true). Checks both old 3-boolean and new unified status field.
 */
export async function recoverPipeline(
  ctx?: ExtensionContext
): Promise<RecoveryResult> {
  const result: RecoveryResult = {
    recovered: 0,
    skipped: 0,
    errors: [],
    details: [],
  };

  let stuck: Awaited<ReturnType<typeof getStuckSessions>>;
  try {
    stuck = await getStuckSessions();
  } catch (e: any) {
    dlog(`Failed to scan for stuck sessions: ${e.message}`);
    result.errors.push(`scan: ${e.message}`);
    return result;
  }

  dlog(`Found ${stuck.length} stuck session(s)`);

  for (const s of stuck) {
    // Attempt weave recovery if compiled but not weaved
    if (!s.hasWeaved) {
      await recoverWeave(s, result);
    }

    // Attempt lint recovery if weaved but not linted
    if (s.hasWeaved && !s.hasLinted) {
      try {
        await markLinted(s.path);
        dlog(`Re-linted: ${s.path}`);
        result.recovered++;
        result.details.push({
          sessionPath: s.path,
          action: "re-linted",
          message: "Pipeline lint status recovered",
        });
      } catch (e: any) {
        result.errors.push(`${s.path} (lint): ${e.message}`);
        result.details.push({
          sessionPath: s.path,
          action: "error",
          message: `Re-lint failed: ${e.message}`,
        });
      }
    }
  }

  return result;
}

async function recoverWeave(
  s: Awaited<ReturnType<typeof getStuckSessions>>[0],
  result: RecoveryResult
): Promise<void> {
  // Need compiledTo to know the wiki page
  if (!s.compiledTo) {
    dlog(`Skip ${s.path}: no compiled_to in frontmatter`);
    result.skipped++;
    result.details.push({
      sessionPath: s.path,
      action: "skipped_no_target",
      message: "No compiled_to field — manual intervention needed",
    });
    return;
  }

  try {
    // Read the wiki page to extract existing backlinks
    let wikiContent: string;
    try {
      wikiContent = await readFile(s.compiledTo);
    } catch {
      // Wiki page doesn't exist — maybe it was deleted
      result.skipped++;
      result.details.push({
        sessionPath: s.path,
        action: "skipped_no_target",
        message: `Wiki page ${s.compiledTo} not found`,
      });
      return;
    }

    // Extract linkedTo from raw session frontmatter, or from wiki page's ## 🔗 相关链接
    const linkedTo = s.linkedTo ?? extractLinkedFromWiki(wikiContent);

    if (linkedTo.length === 0) {
      // Nothing to weave, just mark as weaved
      dlog(`No links to weave for ${s.path}, marking weaved`);
      await markWeaved(s.path);
      result.recovered++;
      result.details.push({
        sessionPath: s.path,
        action: "re-weaved",
        message: "No links to recover — marked weaved",
      });
      return;
    }

    // Re-weave: add backlinks to each linkedTo page
    const errors: string[] = [];
    for (const targetPath of linkedTo) {
      try {
        let targetContent = await readFile(targetPath);
        // Strip wiki/ prefix and .md extension for proper wikilink format
        const wikiRel = s.compiledTo!.replace(/^wiki\//, "").replace(/\.md$/, "");
        const backlink = `- [[wiki/${wikiRel}]]`;

        // Don't add duplicate backlinks
        if (targetContent.includes(backlink)) continue;

        // Add to experience log or related links
        if (targetContent.includes("## 📋 经验日志")) {
          const date = new Date().toISOString().split("T")[0];
          const logEntry = `- [${date}] 关联 [[${s.compiledTo}]] — 管线恢复`;
          targetContent = targetContent.replace(
            /(## 📋 经验日志\n)/,
            `$1${logEntry}\n`
          );
        } else if (targetContent.includes("## 🔗 相关链接")) {
          targetContent = targetContent.replace(
            /## 🔗 相关链接(\n[-\s\S]*?)(\n\n|---|\n##)/,
            `## 🔗 相关链接$1${backlink}$2`
          );
        } else {
          targetContent += `\n\n## 🔗 相关链接\n${backlink}\n`;
        }

        await writeFile(targetPath, targetContent);
        dlog(`  + backlink added to ${targetPath}`);
      } catch (e: any) {
        errors.push(`${targetPath}: ${e.message}`);
      }
    }

    // Mark as weaved
    await markWeaved(s.path);

    if (errors.length === 0) {
      result.recovered++;
      result.details.push({
        sessionPath: s.path,
        action: "re-weaved",
        message: `Pipeline recovery: weaved ${linkedTo.length} link(s)`,
      });
    } else {
      result.recovered++;
      result.details.push({
        sessionPath: s.path,
        action: "re-weaved",
        message: `Partial recovery (${linkedTo.length - errors.length}/${linkedTo.length} links)`,
      });
      for (const err of errors) {
        result.errors.push(err);
      }
    }
  } catch (e: any) {
    result.errors.push(`${s.path}: ${e.message}`);
    result.details.push({
      sessionPath: s.path,
      action: "error",
      message: `Recovery failed: ${e.message}`,
    });
  }
}

/** Extract [[wikilink]] paths from a wiki page's ## 🔗 相关链接 section */
/** Extract [[wikilink]] paths from a wiki page's ## 🔗 相关链接 section */
function extractLinkedFromWiki(content: string): string[] {
  // C3 fix: robust section extraction — handle \n, \r\n, trailing whitespace
  const sectionMatch = content.match(
    /## 🔗 相关链接\r?\n([\s\S]*?)(?=\r?\n## |\r?\n---|\r?\n\[|$)/
  );
  if (!sectionMatch) return [];

  const links: string[] = [];
  const linkRe = /\[\[([^\]]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(sectionMatch[1])) !== null) {
    links.push(m[1].trim());
  }
  return links;
}

/**
 * Register pipeline recovery in the before_agent_start hook.
 */
export function registerPipelineRecovery(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (_event, ctx) => {
    try {
      const result = await recoverPipeline(ctx);
      if (result.recovered > 0 || result.errors.length > 0) {
        console.error(
          `[pi-llm-wiki] Pipeline recovery: ${result.recovered} recovered, ${result.errors.length} errors`
        );
        result.errors.forEach((e) => console.error(`  [pi-llm-wiki]   ↳ ${e}`));
      }
    } catch (e: any) {
      console.error(`[pi-llm-wiki] Pipeline recovery failed: ${e.message}`);
    }
  });
}
