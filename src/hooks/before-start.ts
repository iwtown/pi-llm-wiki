/**
 * pi-llm-wiki — before_agent_start hook.
 * Injects schema.md (LLM-Wiki constitution) into the system prompt at session start.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile, ping } from "../client";
import { PATHS, LLM_WIKI } from "../config";
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
