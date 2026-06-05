/**
 * pi-llm-wiki — obs-lint tool.
 * Health check for the LLM-Wiki knowledge base.
 * Checks: orphan nodes, stale content, contradictions, broken links.
 * With fix=true, auto-marks stale pages with status: stale in frontmatter.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { listDir, readFile, writeFile } from "../client";
import { PATHS, STALE_DAYS } from "../config";

export interface LintIssue {
  type: "orphan" | "stale" | "broken_link" | "missing_frontmatter" | "duplicate";
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
        const fm = fmMatch[1];

        // Check stale
        const updatedMatch = fm.match(/updated:\s*(\S+)/);
        const compiledMatch = fm.match(/compiled:\s*(\S+)/);
        const lastDate = updatedMatch?.[1] ?? compiledMatch?.[1];
        if (lastDate && lastDate < staleCutoff) {
          issues.push({
            type: "stale",
            path: fp,
            message: `超过 ${STALE_DAYS} 天未更新 (last: ${lastDate})`,
            severity: "warning",
          });
        }

        const titleMatch = fm.match(/title:\s*"?(.+?)"?\s*$/m);
        if (titleMatch) {
          allTitles.set(titleMatch[1], fp);
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
  const skipOrphan = [PATHS.index, PATHS.dashboard, PATHS.hot, PATHS.inspection, PATHS.issues];

  for (const fp of wikiFiles) {
    const name = fp.replace("wiki/", "").replace(".md", "");
    const title = allContents.get(fp)?.match(/title:\s*"?(.+?)"?\s*$/m)?.[1] ?? name;

    const incoming = incomingCount.get(fp) ?? 0;
    const incomingByTitle = incomingCount.get(title) ?? 0;
    const incomingByName = incomingCount.get(name) ?? 0;
    const totalIncoming = incoming + incomingByTitle + incomingByName;

    if (totalIncoming === 0 && !skipOrphan.includes(fp) && !fp.startsWith("wiki/索引/")) {
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

  return {
    issues,
    summary: { total: issues.length, errors, warnings, info },
    ...(fixed.length > 0 ? { fixed } : {}),
  };
}
