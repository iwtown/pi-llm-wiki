/**
 * pi-llm-wiki — System page refresh hook.
 * Regenerates dashboard, audit, and tracker on before_agent_start.
 * Writes directly to vault filesystem (API-independent).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { LLM_WIKI } from "../config";
import { generateDashboard } from "./dashboard";
import { generateAudit } from "./audit";
import { generateTracker } from "./tracker";
import { recoverPipeline } from "./recovery";

const VAULT = LLM_WIKI.vault;

function writeSystemPage(relPath: string, content: string): void {
  const fullPath = path.join(VAULT, relPath);
  const dir = path.dirname(fullPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fullPath, content, "utf-8");
}

export function refreshSystemPages(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (_event, _ctx) => {
    try {
      // P-4: Auto-recover stuck pipeline sessions before refreshing pages
      const recovery = await recoverPipeline();
      if (recovery.recovered > 0) {
        console.error(`[pi-llm-wiki] Pipeline recovery: ${recovery.recovered} recovered (${recovery.errors.length} errors)`);
      }

      writeSystemPage("wiki/仪表盘.md", generateDashboard());
      writeSystemPage("wiki/流程巡检.md", generateAudit());
      writeSystemPage("wiki/问题追踪.md", generateTracker());
      console.error("[pi-llm-wiki] System pages refreshed");
    } catch (e: any) {
      console.error(`[pi-llm-wiki] Failed to refresh system pages: ${e.message}`);
    }
  });
}
