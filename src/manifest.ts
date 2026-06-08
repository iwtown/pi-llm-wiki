/**
 * pi-llm-wiki — Manifest tracking for compiled/weaved/linted status.
 * Reads/writes frontmatter fields: compiled, weaved, linted on raw/sessions/ files.
 */

import { readFile, writeFile } from "./client";
import { PATHS } from "./config";
import { parseFrontmatter } from "./system/parse";

export { parseFrontmatter };

export interface SessionStatus {
  path: string; // relative path in vault, e.g. raw/sessions/Pi-Agent/2026-06-05-foo.md
  compiled: boolean;
  weaved: boolean;
  linted: boolean;
  title?: string;
  project?: string;
}

/** Update frontmatter in markdown text */
export function updateFrontmatter(md: string, updates: Record<string, unknown>): string {
  const match = md.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    // No frontmatter, create one
    const lines = Object.entries(updates).map(([k, v]) => `${k}: ${quoteYaml(v)}`);
    return `---\n${lines.join("\n")}\n---\n\n${md}`;
  }
  const existing = parseFrontmatter(md);
  const merged = { ...existing, ...updates };
  const lines = Object.entries(merged).map(([k, v]) => `${k}: ${quoteYaml(v)}`);
  return md.replace(/^---\n[\s\S]*?\n---/, `---\n${lines.join("\n")}\n---`);
}

/** Quote YAML value if it contains special characters */
export function quoteYaml(v: unknown): string {
  if (typeof v === "boolean") return String(v);
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) {
    return "[" + v.map(String).join(", ") + "]";
  }
  const s = String(v);
  if (/[:#\{\}\[\],&\*\?\|<>="'!%@`]/.test(s) || s.includes("\n")) {
    return `"${s.replace(/"/g, '\\"')}"`;
  }
  return s;
}

/** Mark a session as compiled, with optional compile target and linked pages */
export async function markCompiled(
  sessionPath: string,
  options?: { compiledTo?: string; linkedTo?: string[] }
): Promise<void> {
  const content = await readFile(sessionPath);
  const updates: Record<string, unknown> = {
    compiled: true,
    updated: new Date().toISOString().split("T")[0],
  };
  if (options?.compiledTo) updates.compiled_to = options.compiledTo;
  if (options?.linkedTo && options.linkedTo.length > 0) {
    updates.linked_to = options.linkedTo;
  }
  const updated = updateFrontmatter(content, updates);
  await writeFile(sessionPath, updated);
}

/** Mark a session as weaved */
export async function markWeaved(sessionPath: string): Promise<void> {
  const content = await readFile(sessionPath);
  const updated = updateFrontmatter(content, { weaved: true });
  await writeFile(sessionPath, updated);
}

/** Mark a session as linted */
export async function markLinted(sessionPath: string): Promise<void> {
  const content = await readFile(sessionPath);
  const updated = updateFrontmatter(content, { linted: true });
  await writeFile(sessionPath, updated);
}

/** Find sessions stuck in pipeline: compiled but not weaved or not linted */
export async function getStuckSessions(): Promise<
  Array<{ path: string; hasWeaved: boolean; hasLinted: boolean; compiledTo?: string; linkedTo?: string[] }>
> {
  const { listDir } = await import("./client");
  const stuck: Array<{
    path: string;
    hasWeaved: boolean;
    hasLinted: boolean;
    compiledTo?: string;
    linkedTo?: string[];
  }> = [];

  async function walk(dir: string) {
    try {
      const entries = await listDir(dir);
      for (const e of entries) {
        const full = `${dir}/${e}`;
        if (e.endsWith(".md")) {
          const content = await readFile(full);
          const fm = parseFrontmatter(content);
          if (fm.compiled === true || fm.compiled === "true") {
            const hasWeaved = fm.weaved === true || fm.weaved === "true";
            const hasLinted = fm.linted === true || fm.linted === "true";
            if (!hasWeaved || !hasLinted) {
              stuck.push({
                path: full,
                hasWeaved,
                hasLinted,
                compiledTo: fm.compiled_to as string | undefined,
                linkedTo: Array.isArray(fm.linked_to) ? (fm.linked_to as string[]) : undefined,
              });
            }
          }
        } else if (!e.includes(".")) {
          await walk(full);
        }
      }
    } catch { /* skip */ }
  }

  await walk(PATHS.rawSessions);
  return stuck;
}

/** Get all uncompiled session paths */
export async function getUncompiledSessions(): Promise<string[]> {
  const { listDir } = await import("./client");
  const allFiles: string[] = [];

  // Walk raw/sessions/ directory tree
  async function walk(dir: string) {
    try {
      const entries = await listDir(dir);
      for (const e of entries) {
        const full = `${dir}/${e}`;
        if (e.endsWith(".md")) {
          allFiles.push(full);
        } else if (!e.includes(".")) {
          await walk(full);
        }
      }
    } catch {
      // directory doesn't exist
    }
  }

  await walk(PATHS.rawSessions);

  // Check frontmatter for compiled status
  const uncompiled: string[] = [];
  for (const f of allFiles) {
    try {
      const content = await readFile(f);
      const fm = parseFrontmatter(content);
      if (!fm.compiled || fm.compiled === "false" || fm.compiled === false) {
        uncompiled.push(f);
      }
    } catch {
      // skip unreadable files
    }
  }
  return uncompiled;
}
