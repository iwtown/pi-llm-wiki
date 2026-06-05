/**
 * pi-llm-wiki — Manifest tracking for compiled/weaved/linted status.
 * Reads/writes frontmatter fields: compiled, weaved, linted on raw/sessions/ files.
 */

import { readFile, writeFile } from "./client";
import { PATHS } from "./config";

export interface SessionStatus {
  path: string; // relative path in vault, e.g. raw/sessions/Pi-Agent/2026-06-05-foo.md
  compiled: boolean;
  weaved: boolean;
  linted: boolean;
  title?: string;
  project?: string;
}

/** Parse YAML frontmatter from markdown text */
function parseFrontmatter(md: string): Record<string, unknown> {
  const match = md.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const yaml = match[1];
  const result: Record<string, unknown> = {};
  for (const line of yaml.split("\n")) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) {
      const key = kv[1];
      let val: unknown = kv[2].trim();
      if (val === "true") val = true;
      else if (val === "false") val = false;
      result[key] = val;
    }
  }
  return result;
}

/** Update frontmatter in markdown text */
function updateFrontmatter(md: string, updates: Record<string, unknown>): string {
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
function quoteYaml(v: unknown): string {
  if (typeof v === "boolean") return String(v);
  if (typeof v === "number") return String(v);
  const s = String(v);
  if (/[:#\{\}\[\],&\*\?\|<>=!%@`]/.test(s) || s.includes("\n")) {
    return `"${s.replace(/"/g, '\\"')}"`;
  }
  return s;
}

/** Mark a session as compiled */
export async function markCompiled(sessionPath: string): Promise<void> {
  const content = await readFile(sessionPath);
  const updated = updateFrontmatter(content, {
    compiled: true,
    updated: new Date().toISOString().split("T")[0],
  });
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
