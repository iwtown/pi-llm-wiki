/**
 * pi-llm-wiki — before_agent_start hook.
 * Injects runtime schema (schema.md, ~800 tokens) into the system prompt.
 * Also logs a warning when pipeline backlog exceeds threshold (no auto-trigger).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "../client";
import { PATHS, LLM_WIKI, COMPILE_THRESHOLD } from "../config";
import * as fs from "node:fs";
import * as path from "node:path";
import { dlog, slog } from "../system/log";
import { buildIngestedIndex } from "../tools/ingest";
import { getUncompiledSessions } from "../manifest";
import { detectProject } from "../project";
import { parseFrontmatter } from "../system/parse";

let schemaCache: string | null = null;
let schemaCacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function injectSchema(pi: ExtensionAPI): Promise<void> {
  pi.on("before_agent_start", async (event, ctx) => {
    try {
      // Use cache if fresh
      if (schemaCache && Date.now() - schemaCacheTime < CACHE_TTL_MS) {
        const prefix = buildSystemPromptPrefix(schemaCache!, ctx.cwd);
        return { systemPrompt: event.systemPrompt + prefix };
      }

      schemaCache = readFile(PATHS.schema);
      schemaCacheTime = Date.now();

      const prefix = buildSystemPromptPrefix(schemaCache, ctx.cwd);
      return { systemPrompt: event.systemPrompt + prefix };
    } catch (e: any) {
      dlog(`Failed to inject schema: ${e.message}`);
      slog("schema_inject_fail", { error: e.message });
      return undefined;
    }
  });
}

// ─── Knowledge preview (Layer 1: awareness at session start) ───

/** Build the system prompt prefix: schema rules + optional knowledge preview */
function buildSystemPromptPrefix(schema: string, cwd?: string): string {
  const schemaBlock = `\n\n---\n# LLM-Wiki 知识库规则\n\n${schema}\n\n---\n`;

  // If no cwd available, skip knowledge preview
  if (!cwd) return schemaBlock;

  try {
    const preview = buildKnowledgePreview(cwd);
    if (!preview) return schemaBlock;
    return schemaBlock + preview;
  } catch (e) {
    // Non-fatal: knowledge preview failure shouldn't block schema injection
    return schemaBlock;
  }
}

/** Cached project index (keyed by project name, TTL same as schema) */
let projectIndexCache: { data: Record<string, { path: string; title: string; quality_score: number }[]>; time: number } | null = null;

/**
 * Read project-index.json from vault (built by pipeline).
 * Returns a map of projectName → pages, or null if unavailable.
 */
function readProjectIndex(): Record<string, { path: string; title: string; quality_score: number }[]> | null {
  const now = Date.now();
  if (
    projectIndexCache &&
    now - projectIndexCache.time < CACHE_TTL_MS
  ) {
    return projectIndexCache.data;
  }

  try {
    const indexPath = path.join(LLM_WIKI.vault, PATHS.projectIndex);
    const raw = fs.readFileSync(indexPath, "utf-8");
    const parsed = JSON.parse(raw);
    const projects = parsed?.projects;
    if (!projects || typeof projects !== "object") return null;

    projectIndexCache = { data: projects, time: now };
    return projects;
  } catch {
    return null;
  }
}

/**
 * Build a knowledge preview that injects CONTENT (not just links).
 * Top-1 page gets title + summary + insight count; pages 2-3 show as links.
 * Uses project index (O(1)) + reads only 1 file for the summary.
 */
function buildKnowledgePreview(cwd: string): string {
  const project = detectProject(cwd);
  if (!project) return "";

  const projectName = project.name.toLowerCase();
  const projects = readProjectIndex();
  if (!projects) return "";

  const matched = projects[projectName];
  if (!matched || matched.length === 0) return "";

  const vaultDir = LLM_WIKI.vault;
  const top = matched.slice(0, 3);

  // Build rich entry for top-1: read its content inline
  let topLine = "";
  try {
    const fullPath = path.join(vaultDir, top[0].path);
    const content = fs.readFileSync(fullPath, "utf-8");
    const fm = parseFrontmatter(content);
    const summary = typeof fm.summary === "string" ? fm.summary : "";

    // Count decisions + insights from body
    const body = content.replace(/^---[\s\S]*?---\n*/, "");
    const dc = (body.match(/^- /gm) || []).length;

    let text = top[0].title;
    if (summary) text += ` — ${summary.slice(0, 100)}`;
    if (dc > 0) text += ` (${dc}条知识)`;
    topLine = `• ${text}\n`;
  } catch {
    // Fallback: show as plain link
    topLine = `• [[${top[0].path}]]\n`;
  }

  // Pages 2-3 as compact links
  const restLinks = top.slice(1).map((p) => `[[${p.path}]]`).join(" · ");
  const restLine = restLinks ? `${restLinks}\n` : "";

  return `\n📚 当前相关:\n${topLine}${restLine}\n---\n`;
}

// ─── Pipeline backlog check (warning-only, no auto-trigger) ───

function countPendingRaw(): number {
  return getUncompiledSessions().length;
}

/** Lightweight pipeline backlog check — warns when backlog exceeds threshold */
function checkPipelineHealth(): void {
  try {
    const pending = countPendingRaw();
    if (pending >= COMPILE_THRESHOLD) {
      slog("pipeline_backlog", { pending, threshold: COMPILE_THRESHOLD });
      dlog(`Backlog: ${pending} sessions pending (threshold: ${COMPILE_THRESHOLD})`);
    }
  } catch { /* non-fatal */ }
}

/** Build session ID dedup cache (fire-and-forget, runs in parallel with schema injection) */
export function buildIngestCache(): void {
  setTimeout(() => buildIngestedIndex(LLM_WIKI.vault), 0);
}

// Inject pipeline health check into the before_agent_start handler
// Fire-and-forget: doesn't block session startup
export async function injectPipelineCheck(pi: ExtensionAPI): Promise<void> {
  pi.on("before_agent_start", async () => {
    setTimeout(() => checkPipelineHealth(), 500);
  });
}
