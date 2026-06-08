/**
 * pi-llm-wiki — Shared YAML frontmatter parsing.
 * Single source of truth — replaces 5 duplicate parseFrontmatter functions.
 */

/** Parse YAML frontmatter from markdown text. Strips surrounding quotes from values. */
export function parseFrontmatter(md: string): Record<string, unknown> {
  const match = md.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const yaml = match[1];
  const result: Record<string, unknown> = {};
  for (const line of yaml.split("\n")) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const raw = kv[2].trim();

    // Strip surrounding YAML quotes ("val" or 'val')
    const unquoted = raw.replace(/^["']|["']$/g, "");

    // Parse booleans and numbers from unquoted value
    let val: unknown;
    if (unquoted === "true") val = true;
    else if (unquoted === "false") val = false;
    else if (/^-?\d+$/.test(unquoted)) val = parseInt(unquoted, 10);
    else val = unquoted;

    result[key] = val;
  }
  return result;
}

/** Extract a specific string field from frontmatter (sugar) */
export function getStringField(fm: Record<string, unknown>, key: string, fallback = ""): string {
  const v = fm[key];
  if (typeof v === "string") return v;
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  return fallback;
}
