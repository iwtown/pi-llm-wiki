/**
 * pi-llm-wiki — obs-query tool.
 * Searches the LLM-Wiki knowledge base.
 * Strategy: 图谱.md index → full-text search → read file (escalating, per schema §8).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { search, readFile } from "../client";
import { QUERY_DEFAULT_LIMIT, PATHS } from "../config";

interface QueryResult {
  title: string;
  path: string;
  snippet: string;
  score: number;
  tags?: string[];
  source?: "atlas" | "search";
}

/** Parse YAML frontmatter tags from a markdown string */
function extractTags(md: string): string[] {
  const match = md.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return [];
  const tagMatch = match[1].match(/tags:\s*\[(.+?)\]/);
  if (!tagMatch) return [];
  return tagMatch[1].split(",").map((t) => t.trim().replace(/"/g, ""));
}

/** Extract wikilinks and descriptions from 图谱.md content */
function parseAtlasLinks(content: string): Array<{ path: string; description: string }> {
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
function matchScore(query: string, text: string): number {
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

  // Step 1: Check 图谱.md for matching pages (cheapest — §8)
  const atlasResults: QueryResult[] = [];
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

    // Enrich matched atlas pages
    for (const s of scored) {
      const fullPath = s.path.endsWith(".md") ? s.path : s.path + ".md";
      const enriched = await enrichResult(fullPath, s.description, s.score);
      enriched.source = "atlas";
      atlasResults.push(enriched);
    }
  } catch {
    // Atlas unavailable, fall through to search
  }

  // If 图谱 gave enough results, return them
  if (atlasResults.length >= limit) {
    return atlasResults.slice(0, limit);
  }

  // Step 2: Full-text search via REST API for remaining slots
  const remaining = limit - atlasResults.length;
  let searchResults: QueryResult[] = [];
  try {
    const raw = await search(queryStr, remaining * 2);
    const enriched = await Promise.all(
      raw.map(
        async (r) =>
          await enrichResult(
            r.filename,
            r.matches?.[0]?.context?.slice(0, 200) ?? "",
            r.score,
          )
      )
    );
    searchResults = enriched.map((r) => ({ ...r, source: "search" as const }));
  } catch {
    // search unavailable
  }

  // Merge: atlas results first (higher trust), then search, deduplicate by path
  const seen = new Set(atlasResults.map((r) => r.path));
  const merged = [...atlasResults];
  for (const r of searchResults) {
    if (!seen.has(r.path) && merged.length < limit) {
      seen.add(r.path);
      merged.push(r);
    }
  }

  return merged.slice(0, limit);
}
