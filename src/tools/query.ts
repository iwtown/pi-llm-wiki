/**
 * pi-llm-wiki — obs-query tool.
 * Searches the LLM-Wiki knowledge base.
 * Strategy: 图谱.md index → full-text search → read file (escalating, per schema §8).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFile, appendToFile, writeFile } from "../client";
import { QUERY_DEFAULT_LIMIT, PATHS, LLM_WIKI } from "../config";

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

interface QueryResult {
  title: string;
  path: string;
  snippet: string;
  score: number;
  tags?: string[];
  source?: "atlas" | "search" | "semantic" | "zinbox";
}

/** Parse YAML frontmatter tags from a markdown string */
export function extractTags(md: string): string[] {
  const match = md.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return [];
  const tagMatch = match[1].match(/tags:\s*\[(.+?)\]/);
  if (!tagMatch) return [];
  return tagMatch[1].split(",").map((t) => t.trim().replace(/"/g, ""));
}

/** Extract wikilinks and descriptions from 图谱.md content */
export function parseAtlasLinks(content: string): Array<{ path: string; description: string }> {
  const links: Array<{ path: string; description: string }> = [];
  // Match lines like: - [[wiki/概念/项目结构]] — Pi 生态全局目录
  const re = /-\s+\[\[([^\]]+)\]\](?:\s*[—\-]\s*(.+))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    links.push({ path: m[1].trim(), description: (m[2] ?? "").trim() });
  }
  return links;
}

/** Lightweight alias normalization for matchScore */
const CANONICAL: Record<string, string> = {
  config: "configuration", 设置: "configuration", 配置: "configuration",
  skill: "ability", skills: "ability", 能力: "ability", 能力包: "ability",
  ingests: "ingest", 编译: "ingest", 写入: "ingest",
  query: "search", 查询: "search", 搜索: "search", 搜: "search",
  agent: "agent", 助手: "agent",
  extension: "extension", 扩展: "extension", extensions: "extension",
};

/** Score how well a query matches a string (simple case-insensitive word overlap) */
export function matchScore(query: string, text: string): number {
  const qLower = query.toLowerCase();
  const tLower = text.toLowerCase();
  // Alias normalization: map synonyms to canonical forms for better matching
  const norm = (s: string) => {
    let out = s;
    for (const [k, v] of Object.entries(CANONICAL)) {
      out = out.replaceAll(k, v);
    }
    return out;
  };
  const qNorm = norm(qLower);
  const tNorm = norm(tLower);
  // Exact substring match = highest
  if (tNorm.includes(qNorm)) return 1;
  // Word overlap
  const qWords = qNorm.split(/\s+/);
  const tWords = new Set(tNorm.split(/\s+/));
  let hits = 0;
  for (const w of qWords) {
    if (w.length < 2) continue;
    if (tWords.has(w)) hits++;
    // Partial word match
    for (const tw of tWords) {
      if (tw.includes(w) || w.includes(tw)) { hits += 0.5; break; }
    }
  }
  return hits / Math.max(qWords.length, 1);
}

/** Enrich raw results with frontmatter (title, tags) */
async function enrichResult(
  path: string,
  snippet: string,
  score: number,
): Promise<QueryResult> {
  try {
    const content = await readFile(path);
    const titleMatch = content.match(/^title:\s*"?(.+?)"?\s*$/m);
    const title = titleMatch?.[1] ?? path.replace(".md", "").split("/").pop()!;
    const tags = extractTags(content);
    return { title, path, snippet, score, tags };
  } catch {
    return {
      title: path.replace(".md", "").split("/").pop()!,
      path,
      snippet: "",
      score,
    };
  }
}

export async function query(
  queryStr: string,
  params: { scope?: string; limit?: number; depth?: "brief" | "normal" | "full" },
  ctx: ExtensionContext
): Promise<QueryResult[]> {
  const limit = params.limit ?? QUERY_DEFAULT_LIMIT;
  // C1 fix: scope filtering
  const scope = params.scope ?? "all";

  // Step 1: Check 图谱.md for matching pages (cheapest — §8)
  // Skip atlas if scope is "raw" (图谱 only covers wiki/ pages)
  const depth = params.depth ?? "normal";

  const atlasResults: QueryResult[] = [];

  // Only scan atlas for wiki or all scope
  if (scope !== "raw") {
  try {
    const atlasContent = await readFile(PATHS.index);
    const atlasLinks = parseAtlasLinks(atlasContent);

    // Score and filter atlas links against query
    const scored = atlasLinks
      .map((link) => ({
        ...link,
        score: Math.max(
          matchScore(queryStr, link.path),
          matchScore(queryStr, link.description),
        ),
      }))
      .filter((l) => l.score > 0.2)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    // brief: skip enrichment, return titles + paths only
    if (depth === "brief") {
      for (const s of scored) {
        const fullPath = s.path.endsWith(".md") ? s.path : s.path + ".md";
        atlasResults.push({
          title: fullPath.replace(/^.*\//, "").replace(/\.md$/, ""),
          path: fullPath,
          snippet: s.description || "",
          score: s.score,
          source: "atlas",
        });
      }
    } else {
      // normal + full: enrich with frontmatter
      for (const s of scored) {
        const fullPath = s.path.endsWith(".md") ? s.path : s.path + ".md";
        const enriched = await enrichResult(fullPath, s.description, s.score);
        enriched.source = "atlas";
        // full: also fetch body content
        if (depth === "full") {
          try {
            const body = await readFile(fullPath);
            // Append body preview (first 500 chars after frontmatter)
            const bodyText = body.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
            enriched.snippet = bodyText.slice(0, 500);
          } catch {
            // keep existing snippet on read failure
          }
        }
        atlasResults.push(enriched);
      }
    }
  } catch {
    // Atlas unavailable, fall through to search
  }
  } // end scope !== "raw"

  // ── ZInBox external vault search (runs even in "brief" mode) ──
  const zinboxResults: QueryResult[] = [];
  if ((scope === "all" || scope === "zinbox") && atlasResults.length < limit) {
    const zinboxRemaining = limit - atlasResults.length;
    const zinboxDir = LLM_WIKI.zinbox;
    const safeQuery = queryStr.replace(/"/g, '\\"');
    let grepOut = "";
    try {
      grepOut = execSync(
        `grep -srl -i --include='*.md' "${safeQuery}" "${zinboxDir}"`,
        { timeout: 8000, encoding: "utf-8", maxBuffer: 1024 * 512 }
      ).trim();
    } catch (e: any) {
      if (e.status === 1) { grepOut = ""; } else if (e.stdout) { grepOut = e.stdout.toString().trim(); }
    }
    if (grepOut) {
      const files = grepOut.split("\n").filter(Boolean).slice(0, zinboxRemaining);
      for (const f of files) {
        const rel = path.relative(zinboxDir, f);
        zinboxResults.push({
          title: rel.replace(/^.*[\\\/]/, "").replace(/\.md$/, ""),
          path: `zinbox://${rel}`,
          snippet: "",
          score: 1,
          source: "zinbox" as const,
        });
      }
    }
  }

  // Merge ZInBox results into atlasResults (dedup by path)
  const seen = new Set(atlasResults.map((r) => r.path));
  for (const r of zinboxResults) {
    if (!seen.has(r.path) && atlasResults.length + 1 <= limit) {
      seen.add(r.path);
      atlasResults.push(r);
    }
  }

  // Step 2: Semantic search via Smart Connections (G2)
  // Skip search for "brief" — return atlas+zinbox results as-is
  if (depth === "brief" || atlasResults.length >= limit) {
    return atlasResults.slice(0, limit);
  }

  const remaining = limit - atlasResults.length;
  let searchResults: QueryResult[] = [];

  // 2: Full-text search via ripgrep
  try {
    const raw = fullTextSearch(queryStr, remaining * 2);
    const enriched = await Promise.all(
      raw.map(
        async (r) => {
          const result = await enrichResult(
            r.filename,
            r.context?.slice(0, 200) ?? "",
            r.score,
          );
          result.source = "search";
          // full: fetch body content
          if (depth === "full") {
            try {
              const body = await readFile(r.filename);
              const bodyText = body.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
              result.snippet = bodyText.slice(0, 500);
            } catch {
              // keep existing snippet
            }
          }
          return result;
        }
      )
    );
    searchResults = enriched;
  } catch {
    // search unavailable
  }

  // C1: Filter search results by scope
  const scopedSearch = searchResults.filter((r) => {
    if (scope === "all") return true;
    if (scope === "wiki") return r.path.startsWith("wiki/");
    if (scope === "prompt") return r.path.startsWith("wiki/提示/");
    if (scope === "gene") return r.path.startsWith("wiki/基因/");
    return r.path.startsWith("raw/");
  });

  // Merge: atlas results first (higher trust), then search, deduplicate by path
  const merged = [...atlasResults];
  for (const r of scopedSearch) {
    if (!seen.has(r.path) && merged.length < limit) {
      seen.add(r.path);
      merged.push(r);
    }
  }

  // Log query to log.md (best-effort)
  const date = new Date().toISOString().split("T")[0];
  const resultCount = merged.length;
  try {
    await appendToFile(
      PATHS.log,
      `## [${date}] query | "${queryStr.slice(0, 60)}" → ${resultCount} 条结果 (${scope}, ${depth})`
    );
  } catch {
    // non-fatal
  }

  // Track query stats for top results (fire-and-forget, non-blocking)
  for (const r of merged.slice(0, 3)) {
    // Only track wiki/ pages, not zinbox or raw
    if (r.path.startsWith("wiki/")) {
      trackQueryHit(r.path, date).catch(() => {});
    }
  }

  return merged.slice(0, limit);
}

// ─── Query tracking (Layer 3: implicit feedback) ───

/** Ripgrep-based full-text search (no REST API dependency) */
interface FtsResult { filename: string; score: number; context?: string; }
function fullTextSearch(query: string, limit: number): FtsResult[] {
  const results: FtsResult[] = [];
  try {
    const safeQuery = query.replace(/"/g, '\\"');
    const grep = execSync(
      `rg -l -i "${safeQuery}" "${LLM_WIKI.vault}/wiki/"`,
      { timeout: 5000, encoding: "utf-8" }
    ).trim().split("\n").filter(Boolean).slice(0, limit);
    for (const f of grep) {
      const rel = f.replace(LLM_WIKI.vault + "/", "");
      // Get first match context via rg -C0
      let ctx = "";
      try {
        ctx = execSync(
          `rg -m1 -i "${safeQuery}" "${f}"`,
          { timeout: 3000, encoding: "utf-8" }
        ).trim().slice(0, 200);
      } catch { /* no match line */ }
      results.push({ filename: rel, score: 1, context: ctx });
    }
  } catch { /* rg not available or failed */ }
  return results;
}

/**
 * Track that a wiki page was queried — updates frontmatter stats.
 * Fire-and-forget: never blocks query return.
 */
async function trackQueryHit(filePath: string, date: string): Promise<void> {
  try {
    const content = await readFile(filePath);

    // Check if queried_count already exists
    if (/^queried_count:\s*\d+$/m.test(content)) {
      const updated = content
        .replace(/^(queried_count:\s*)(\d+)$/m, (_, label, count) =>
          `${label}${parseInt(count, 10) + 1}`
        )
        .replace(/^(last_queried:\s*).+$/m, `$1${date}`);
      await writeFile(filePath, updated);
    } else {
      // Insert queried_count + last_queried before the closing ---
      const fmEnd = content.indexOf("\n---", 4);
      if (fmEnd > 0) {
        const before = content.slice(0, fmEnd + 4);
        const after = content.slice(fmEnd + 4);
        await writeFile(filePath, before + `\nqueried_count: 1\nlast_queried: ${date}` + after);
      }
    }
  } catch {
    // non-fatal: tracking failure shouldn't affect query result
  }
}

