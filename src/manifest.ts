/**
 * pi-llm-wiki — Unified pipeline state tracker.
 * All frontmatter reads/writes go through this module.
 * Sources: raw session files (compiled/weaved/linted/status) + wiki pages (quality/queried).
 */

import { readFile, writeFile, listDir } from "./client";
import { PATHS } from "./config";
import { parseFrontmatter } from "./system/parse";

export { parseFrontmatter };

// ─── Single-field access (replaces ad-hoc regex across codebase) ───

/** Read a single frontmatter field from file content. Returns undefined if missing. */
export function getField(content: string, key: string): unknown {
  const fm = parseFrontmatter(content);
  return fm[key];
}

// ─── Frontmatter update ───

/** Update frontmatter in markdown text */
export function updateFrontmatter(md: string, updates: Record<string, unknown>): string {
  const match = md.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
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
  if (Array.isArray(v)) return "[" + v.map(String).join(", ") + "]";
  const s = String(v);
  if (/[:#\{\}\[\],&\*\?\|<>="'!%@`]/.test(s) || s.includes("\n"))
    return `"${s.replace(/"/g, '\\"')}"`;
  return s;
}

// ─── Pipeline state API ───

/** Unified session state from a raw/sessions/ file */
export interface SessionState {
  path: string;
  compiled: boolean;
  weaved: boolean;
  linted: boolean;
  status: string; // "pending" | "compiled" | "woven" | "done" | "skipped"
  session_score?: number;
}

/** Read session state from a raw/sessions/ file path */
export function readSessionState(sessionPath: string): SessionState {
  const content = readFile(sessionPath);
  const fm = parseFrontmatter(content);
  const status = (fm.status as string) || "pending";
  return {
    path: sessionPath,
    compiled: fm.compiled === true || fm.compiled === "true" || ["compiled","woven","done","skipped"].includes(status),
    weaved: fm.weaved === true || fm.weaved === "true" || ["woven","done"].includes(status),
    linted: fm.linted === true || fm.linted === "true" || status === "done",
    status,
    session_score: typeof fm.session_score === "number" ? fm.session_score : undefined,
  };
}

// ─── Pipeline marker functions ───

/** Mark a session as compiled */
export function markCompiled(
  sessionPath: string,
  options?: { compiledTo?: string; linkedTo?: string[]; skipped?: string }
): void {
  const content = readFile(sessionPath);
  const updates: Record<string, unknown> = {
    compiled: true,
    updated: new Date().toISOString().split("T")[0],
  };
  updates.status = options?.skipped ? "skipped" : "compiled";
  if (options?.compiledTo) updates.compiled_to = options.compiledTo;
  if (options?.linkedTo && options.linkedTo.length > 0)
    updates.linked_to = options.linkedTo;
  writeFile(sessionPath, updateFrontmatter(content, updates));
}

/** Mark a session as weaved */
export function markWeaved(sessionPath: string): void {
  const content = readFile(sessionPath);
  writeFile(sessionPath, updateFrontmatter(content, { weaved: true, status: "woven" }));
}

/** Mark a session as linted (pipeline complete) */
export function markLinted(sessionPath: string): void {
  const content = readFile(sessionPath);
  writeFile(sessionPath, updateFrontmatter(content, { linted: true, status: "done" }));
}

// ─── Session scanner ───

/** Find all sessions that are compiled but not fully processed */
export function getStuckSessions(): Array<{
  path: string; hasWeaved: boolean; hasLinted: boolean; compiledTo?: string; linkedTo?: string[]; status?: string;
}> {
  const stuck: Array<{
    path: string; hasWeaved: boolean; hasLinted: boolean;
    compiledTo?: string; linkedTo?: string[]; status?: string;
  }> = [];
  try {
    const projects = listDir(PATHS.rawSessions);
    for (const proj of projects) {
      const projDir = `${PATHS.rawSessions}/${proj}`;
      const files = listDir(projDir).filter((f) => f.endsWith(".md"));
      for (const f of files) {
        const full = `${projDir}/${f}`;
        const state = readSessionState(full);
        if (state.compiled && !state.linted) {
          const content = readFile(full);
          stuck.push({
            path: full,
            hasWeaved: state.weaved,
            hasLinted: state.linted,
            status: state.status,
            compiledTo: String(getField(content, "compiled_to") ?? ""),
            linkedTo: getField(content, "linked_to") as string[] | undefined,
          });
        }
      }
    }
  } catch { /* non-fatal */ }
  return stuck;
}

/** Get all session paths that haven't been compiled yet */
export function getUncompiledSessions(): string[] {
  const uncompiled: string[] = [];
  try {
    const projects = listDir(PATHS.rawSessions);
    for (const proj of projects) {
      const projDir = `${PATHS.rawSessions}/${proj}`;
      const files = listDir(projDir).filter((f) => f.endsWith(".md"));
      for (const f of files) {
        const full = `${projDir}/${f}`;
        if (!readSessionState(full).compiled) uncompiled.push(full);
      }
    }
  } catch { /* non-fatal */ }
  return uncompiled;
}
