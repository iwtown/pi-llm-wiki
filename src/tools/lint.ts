/**
 * pi-llm-wiki — obs-lint tool.
 * Health check for the LLM-Wiki knowledge base.
 * Checks: orphan nodes, stale content, contradictions, broken links.
 * With fix=true, auto-marks stale pages with status: stale in frontmatter.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { listDir, readFile, writeFile, appendToFile } from "../client";
import { PATHS, STALE_DAYS } from "../config";
import { collectWikiPages, detectContradictions, detectDuplicates, detectMissingConcepts } from "../system/analyzer";
import { getField } from "../manifest";

export interface LintIssue {
  type: "orphan" | "stale" | "broken_link" | "missing_frontmatter" | "duplicate" | "pipeline_stuck" | "missing_concept";
  path: string;
  message: string;
  severity: "error" | "warning" | "info";
}

export interface LintResult {
  issues: LintIssue[];
  summary: {
    total: number;
    errors: number;
    warnings: number;
    info: number;
  };
  /** Paths that were auto-fixed (only when fix=true) */
  fixed?: string[];
}

/** Add status: stale to frontmatter of a markdown file */
function markStale(content: string): string {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return content;
  const fm = fmMatch[1];
  // Already has status field
  if (/^status:\s*/m.test(fm)) {
    return content.replace(/^status:\s*.*$/m, "status: stale");
  }
  // Insert status after tags line, or before closing ---
  const updated = fm.includes("tags:")
    ? fm.replace(/^(tags:.*)$/m, "$1\nstatus: stale")
    : fm + "\nstatus: stale";
  return `---\n${updated}\n---${content.slice(fmMatch[0].length)}`;
}

export async function lint(
  ctx: ExtensionContext,
  params: { fix?: boolean } = {}
): Promise<LintResult> {
  const issues: LintIssue[] = [];

  // Collect all wiki pages
  const wikiFiles: string[] = [];
  async function walk(dir: string) {
    try {
      const entries = await listDir(dir);
      for (const e of entries) {
        const fp = `${dir}/${e}`;
        if (e.endsWith(".md")) wikiFiles.push(fp);
        else if (!e.includes(".")) await walk(fp);
      }
    } catch {
      // skip inaccessible
    }
  }
  await walk("wiki");

  const allContents = new Map<string, string>();
  const allWikilinks = new Map<string, string[]>(); // file -> linked pages
  const allTitles = new Map<string, string>(); // title -> file path
  const staleDate = new Date();
  staleDate.setDate(staleDate.getDate() - STALE_DAYS);
  const staleCutoff = staleDate.toISOString().split("T")[0];

  // Read all wiki pages
  for (const fp of wikiFiles) {
    try {
      const content = await readFile(fp);
      allContents.set(fp, content);

      // Extract frontmatter
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) {
        issues.push({
          type: "missing_frontmatter",
          path: fp,
          message: "缺少 frontmatter",
          severity: "warning",
        });
      } else {
        // Check stale
        const updStr = String(getField(content, "updated") ?? "");
        const compStr = String(getField(content, "compiled") ?? "");
        const lastDate = updStr || compStr;
        if (lastDate && lastDate < staleCutoff) {
          issues.push({
            type: "stale",
            path: fp,
            message: `超过 ${STALE_DAYS} 天未更新 (last: ${lastDate})`,
            severity: "warning",
          });
        }

        const fmTitle = getField(content, "title");
        if (typeof fmTitle === "string" && fmTitle) {
          allTitles.set(fmTitle, fp);
        }
      }

      // Extract wikilinks
      const links = [...content.matchAll(/\[\[([^\]|#]+?)(?:[|#][^\]]+)?\]\]/g)]
        .map((m) => m[1].trim());
      allWikilinks.set(fp, links);
    } catch {
      // skip
    }
  }

  // Check orphans: pages with no incoming links
  const incomingCount = new Map<string, number>();
  for (const [, links] of allWikilinks) {
    for (const l of links) {
      incomingCount.set(l, (incomingCount.get(l) ?? 0) + 1);
    }
  }

  // Skip index pages (豁免)
  const skipOrphan = [PATHS.index];

  for (const fp of wikiFiles) {
    const name = fp.replace("wiki/", "").replace(".md", "");
    const title = allContents.get(fp)?.match(/title:\s*"?(.+?)"?\s*$/m)?.[1] ?? name;

    const incoming = incomingCount.get(fp) ?? 0;
    const incomingByTitle = incomingCount.get(title) ?? 0;
    const incomingByName = incomingCount.get(name) ?? 0;
    const totalIncoming = incoming + incomingByTitle + incomingByName;

    if (totalIncoming === 0 && !skipOrphan.includes(fp) && !fp.startsWith("wiki/索引/") && !fp.startsWith("wiki/提示/")) {
      issues.push({
        type: "orphan",
        path: fp,
        message: "孤立节点：无页面链接到此页",
        severity: "warning",
      });
    }
  }

  // Check broken links
  const allPaths = new Set(wikiFiles.map((f) => f.replace(".md", "")));
  for (const [fp, links] of allWikilinks) {
    for (const l of links) {
      // Skip external URLs and non-wiki links
      if (l.includes("://") || l.startsWith("#")) continue;
      // Direct match: exact path exists
      if (allPaths.has(l)) continue;
      // Match by filename (without wiki/ prefix)
      const name = l.split("/").pop() ?? l;
      const foundByName = [...allPaths].some((p) => p.endsWith(name));
      // Match by title
      const foundByTitle = allTitles.has(l);
      if (!foundByName && !foundByTitle) {
        issues.push({
          type: "broken_link",
          path: fp,
          message: `断裂链接: [[${l}]]`,
          severity: "info",
        });
      }
    }
  }

  // P4.2: Contradiction detection — same topic in multiple categories
  const allPagesArr = collectWikiPages();
  const contradictions = detectContradictions(allPagesArr);
  for (const c of contradictions.slice(0, 5)) {
    issues.push({
      type: "duplicate",
      path: c.pages[0],
      message: `⚠️ 需决策: ${c.reason}`,
      severity: "warning",
    });
  }

  // K1: Missing concept detection — concepts referenced ≥3 times but lacking pages
  const missingConcepts = detectMissingConcepts(allPagesArr);
  for (const mc of missingConcepts) {
    issues.push({
      type: "missing_concept",
      path: mc.referredBy[0],
      message: `概念 "${mc.concept}" 在 ${mc.refCount} 个页面中被引用但无对应页面 (例如: ${mc.referredBy.slice(0, 3).join(", ")})`,
      severity: "warning",
    });
  }

  // P4.3: Duplicate content detection — pages with >70% similarity
  const dupes = detectDuplicates(allPagesArr, 0.7);
  for (const d of dupes) {
    issues.push({
      type: "duplicate",
      path: d.pageA,
      message: `与 ${d.pageB} 内容相似度 ${Math.round(d.similarity * 100)}%，可能重复`,
      severity: "info",
    });
  }

  // P-4: Pipeline recovery — scan raw sessions for compiled but not weaved/linted
  const stuckSessions: Array<{ path: string; status: string }> = [];
  async function scanRawSessions() {
    async function walk(dir: string) {
      try {
        const entries = await listDir(dir);
        for (const e of entries) {
          const full = `${dir}/${e}`;
          if (e.endsWith(".md")) {
            try {
              const content = await readFile(full);
              // Phase 5: check new status field AND old booleans for backward compat
              const statusMatch = content.match(/\bstatus:\s*(\S+)/);
              const status = statusMatch?.[1]?.replace(/["']/g, "") ?? "";
              const compiled = /compiled:\s*true/.test(content) || ["compiled", "woven", "done"].includes(status);
              const weaved = /weaved:\s*true/.test(content) || ["woven", "done"].includes(status);
              const linted = /linted:\s*true/.test(content) || status === "done";
              if (compiled && (!weaved || !linted)) {
                const status = !weaved ? "已编译未织入" : "已编译未lint";
                stuckSessions.push({ path: full, status });
              }
            } catch { /* skip */ }
          } else if (!e.includes(".")) {
            await walk(full);
          }
        }
      } catch { /* skip */ }
    }
    await walk(PATHS.rawSessions);
  }
  try {
    await scanRawSessions();
  } catch { /* skip */ }

  for (const s of stuckSessions) {
    issues.push({
      type: "pipeline_stuck",
      path: s.path,
      message: `管线卡滞: ${s.status}`,
      severity: "warning",
    });
  }

  // Auto-fix: mark stale pages
  const fixed: string[] = [];
  if (params.fix) {
    const staleIssues = issues.filter((i) => i.type === "stale");
    for (const issue of staleIssues) {
      try {
        const content = allContents.get(issue.path);
        if (!content) continue;
        const updated = markStale(content);
        if (updated !== content) {
          await writeFile(issue.path, updated);
          fixed.push(issue.path);
        }
      } catch {
        // skip unmodifiable files
      }
    }
  }

  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.filter((i) => i.severity === "warning").length;
  const info = issues.filter((i) => i.severity === "info").length;

  // Log lint to log.md (best-effort)
  const date = new Date().toISOString().split("T")[0];
  try {
    await appendToFile(
      PATHS.log,
      `## [${date}] lint | ${issues.length} 个问题 (${errors} errors, ${warnings} warnings, ${info} info)`
    );
  } catch {
    // non-fatal
  }

  return {
    issues,
    summary: { total: issues.length, errors, warnings, info },
    ...(fixed.length > 0 ? { fixed } : {}),
  };
}
