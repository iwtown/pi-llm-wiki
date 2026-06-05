/**
 * pi-llm-wiki — before_agent_start hook.
 * Injects schema.md (LLM-Wiki constitution) into the system prompt at session start.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile, ping } from "../client";
import { PATHS, LLM_WIKI } from "../config";
import * as fs from "node:fs";

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

      // Try REST API first (most reliable, uses full Obsidian parser)
      const online = await ping();
      let schema: string;

      if (online) {
        schema = await readFile(PATHS.schema);
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
      console.error(`[pi-llm-wiki] Failed to inject schema: ${e.message}`);
      return undefined; // allow agent to proceed without schema
    }
  });
}
