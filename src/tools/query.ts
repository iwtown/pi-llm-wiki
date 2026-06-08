/**
 * pi-llm-wiki — obs-query tool.
 * Searches the LLM-Wiki knowledge base.
 * Strategy: 图谱.md index → full-text search → read file (escalating, per schema §8).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { search, smartSearch, readFile } from "../client";
import { QUERY_DEFAULT_LIMIT, PATHS } from "../config";

interface QueryResult {
  title: string;
  path: string;
  snippet: string;
  score: number;
  tags?: string[];
  source?: "atlas" | "search" | "semantic";
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

/** Score how well a query matches a string (simple case-insensitive word overlap) */
export function matchScore(query: string, text: string): number {
  const qLower = query.toLowerCase();
  const tLower = text.toLowerCase();
  // Exact substring match = highest
  if (tLower.includes(qLower)) return 1;
  // Word overlap
  const qWords = qLower.split(/\s+/);
  const tWords = new Set(tLower.split(/\s+/));
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

  // Step 2: Semantic search via Smart Connections (G2)
  // Skip search for "brief" — return atlas results as-is
  if (depth === "brief" || atlasResults.length >= limit) {
    return atlasResults.slice(0, limit);
  }

  const remaining = limit - atlasResults.length;
  let searchResults: QueryResult[] = [];

  // 2a: Try semantic search first
  try {
    const smartRaw = await smartSearch(queryStr, remaining * 2);
    if (smartRaw.length > 0) {
      const enriched = await Promise.all(
        smartRaw.map(
          async (r) => {
            const result = await enrichResult(
              r.path,
              r.text?.slice(0, 200) ?? "",
              r.score,
            );
            result.source = "semantic";
            // full: fetch body content
            if (depth === "full") {
              try {
                const body = await readFile(r.path);
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
    }
  } catch {
    // Smart search unavailable, fall through to simple search
  }

  // 2b: Fallback to full-text search if semantic search returns nothing
  if (searchResults.length === 0) {
    try {
      const raw = await search(queryStr, remaining * 2);
      const enriched = await Promise.all(
        raw.map(
          async (r) => {
            const result = await enrichResult(
              r.filename,
              r.matches?.[0]?.context?.slice(0, 200) ?? "",
              r.score,
            );
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
      searchResults = enriched.map((r) => ({ ...r, source: "search" as const }));
    } catch {
      // search unavailable
    }
  }

  // C1: Filter search results by scope
  const scopedSearch = searchResults.filter((r) => {
    if (scope === "all") return true;
    return r.path.startsWith(scope === "wiki" ? "wiki/" : "raw/");
  });

  // Merge: atlas results first (higher trust), then search, deduplicate by path
  const seen = new Set(atlasResults.map((r) => r.path));
  const merged = [...atlasResults];
  for (const r of scopedSearch) {
    if (!seen.has(r.path) && merged.length < limit) {
      seen.add(r.path);
      merged.push(r);
    }
  }

  return merged.slice(0, limit);
}
