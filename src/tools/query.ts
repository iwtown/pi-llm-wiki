/**
 * pi-llm-wiki — obs-query tool.
 * Searches the LLM-Wiki knowledge base.
 * Strategy: index page → grep → full-text search → read file (escalating).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { search, readFile } from "../client";
import { QUERY_DEFAULT_LIMIT } from "../config";

interface QueryResult {
  title: string;
  path: string;
  snippet: string;
  score: number;
  tags?: string[];
}

/** Parse YAML frontmatter tags from a markdown string */
function extractTags(md: string): string[] {
  const match = md.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return [];
  const tagMatch = match[1].match(/tags:\s*\[(.+?)\]/);
  if (!tagMatch) return [];
  return tagMatch[1].split(",").map((t) => t.trim().replace(/"/g, ""));
}

export async function query(
  queryStr: string,
  params: { scope?: string; limit?: number },
  ctx: ExtensionContext
): Promise<QueryResult[]> {
  const limit = params.limit ?? QUERY_DEFAULT_LIMIT;

  // Step 1: Full-text search via REST API
  const results = await search(queryStr, limit * 2);

  // Step 2: Enrich with frontmatter (title, tags)
  const enriched: QueryResult[] = [];
  for (const r of results) {
    try {
      const content = await readFile(r.filename);
      const titleMatch = content.match(/^title:\s*"?(.+?)"?\s*$/m);
      const title = titleMatch?.[1] ?? r.filename.replace(".md", "").split("/").pop()!;
      const tags = extractTags(content);
      enriched.push({
        title,
        path: r.filename,
        snippet: r.matches?.[0]?.context?.slice(0, 200) ?? "",
        score: r.score,
        tags,
      });
    } catch {
      enriched.push({
        title: r.filename,
        path: r.filename,
        snippet: "",
        score: r.score,
      });
    }
  }

  return enriched.slice(0, limit);
}
