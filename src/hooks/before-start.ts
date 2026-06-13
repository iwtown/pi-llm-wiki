/**
 * pi-llm-wiki — before_agent_start hook.
 * Injects schema.md (LLM-Wiki constitution) into the system prompt at session start.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile, ping } from "../client";
import { PATHS, LLM_WIKI, COMPILE_THRESHOLD } from "../config";
import * as fs from "node:fs";
import * as path from "node:path";
import { dlog } from "../system/log";

/** Retry a promise-returning function with delay */
async function retry<T>(fn: () => Promise<T>, retries: number, delayMs: number): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < retries) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

const SLOG_PATH = path.join(process.env.HOME ?? "/home", ".pi/agent/pi-llm-wiki.log");

let schemaCache: string | null = null;
let schemaCacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function injectSchema(pi: ExtensionAPI): Promise<void> {
  pi.on("before_agent_start", async (event, ctx) => {
    try {
      // Use cache if fresh
      if (schemaCache && Date.now() - schemaCacheTime < CACHE_TTL_MS) {
        const prefix = `\n\n---\n# LLM-Wiki 知识库规则（自动注入）\n\n${schemaCache}\n\n---\n`;
        return { systemPrompt: event.systemPrompt + prefix };
      }

      // C4: Try REST API first with one retry for transient failures
      let online = await ping();
      if (!online) {
        // Retry once after 1s for transient connectivity issues
        await new Promise((r) => setTimeout(r, 1000));
        online = await ping();
      }
      let schema: string;

      if (online) {
        schema = await retry(() => readFile(PATHS.schema), 2, 500);
      } else {
        // Fallback: read from filesystem
        schema = fs.readFileSync(`${LLM_WIKI.vault}/${PATHS.schema}`, "utf-8");
      }

      // Update cache
      schemaCache = schema;
      schemaCacheTime = Date.now();

      // Add to system prompt
      const prefix = `\n\n---\n# LLM-Wiki 知识库规则（自动注入）\n\n${schema}\n\n---\n`;
      return { systemPrompt: event.systemPrompt + prefix };
    } catch (e: any) {
      // Schema injection failure is non-fatal — don't block agent
      dlog(`Failed to inject schema: ${e.message}`);
      try {
        fs.appendFileSync(SLOG_PATH, JSON.stringify({ ts: new Date().toISOString(), event: "schema_inject_fail", error: e.message }) + "\n");
      } catch { /* non-fatal */ }
      return undefined; // allow agent to proceed without schema
    }
  });
}

// ─── Auto-pipeline check (fire-and-forget, non-blocking) ───

function countPendingRaw(): number {
  const rawDir = path.join(LLM_WIKI.vault, PATHS.rawSessions);
  let count = 0;
  try {
    const projects = fs.readdirSync(rawDir);
    for (const proj of projects) {
      const projDir = path.join(rawDir, proj);
      if (!fs.statSync(projDir).isDirectory()) continue;
      const files = fs.readdirSync(projDir).filter((f) => f.endsWith(".md"));
      for (const file of files) {
        const content = fs.readFileSync(path.join(projDir, file), "utf-8");
        const fm = content.match(/^---\n([\s\S]*?)\n---/);
        if (!fm) continue;
        const compiled = fm[1].match(/compiled:\s*(true|\d)/);
        if (compiled) continue; // already compiled
        const scoreMatch = fm[1].match(/session_score:\s*(\d+)/);
        const score = scoreMatch ? parseInt(scoreMatch[1], 10) : 0;
        if (score > 0 && score < 50) continue; // low quality
        count++;
      }
    }
  } catch { /* non-fatal */ }
  return count;
}

/** Lightweight auto-pipeline check — warns when backlog grows past threshold */
function checkPipelineHealth(): void {
  try {
    const pending = countPendingRaw();
    if (pending >= COMPILE_THRESHOLD) {
      dlog(`⚠️ Pipeline backlog: ${pending} sessions pending compilation (threshold: ${COMPILE_THRESHOLD})`);
      try {
        const slogPath = path.join(process.env.HOME ?? "/home", ".pi/agent/pi-llm-wiki.log");
        fs.appendFileSync(slogPath, JSON.stringify({
          ts: new Date().toISOString(),
          event: "pipeline_backlog",
          pending,
          threshold: COMPILE_THRESHOLD,
        }) + "\n");
      } catch { /* non-fatal */ }
    }
    if (pending > 10) {
      dlog(`🔴 Large pipeline backlog (${pending} pending). Run: cd ~/projects/pi-llm-wiki && npm run pipeline`);
    }
  } catch { /* non-fatal */ }
}

// Inject pipeline health check into the before_agent_start handler
// Fire-and-forget: doesn't block session startup
export async function injectPipelineCheck(pi: ExtensionAPI): Promise<void> {
  pi.on("before_agent_start", async () => {
    setTimeout(() => checkPipelineHealth(), 500);
  });
}
