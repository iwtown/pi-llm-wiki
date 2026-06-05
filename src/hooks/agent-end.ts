/**
 * pi-llm-wiki — agent_end hook.
 * Auto-ingests the session when agent_end fires (safety net if obs_ingest wasn't called).
 * Skips if obs_ingest was already explicitly called this session.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ingest } from "../tools/ingest";

const INGEST_MARKER = "pi-llm-wiki:ingested";

export function markIngested(pi: ExtensionAPI): void {
  try {
    pi.appendEntry(INGEST_MARKER, { timestamp: Date.now() });
  } catch {
    // non-fatal
  }
}

export async function autoIngest(pi: ExtensionAPI): Promise<void> {
  pi.on("agent_end", async (event, ctx) => {
    try {
      // Check if obs_ingest was already called this session
      const entries = ctx.sessionManager?.getEntries?.() ?? [];
      const alreadyIngested = entries.some(
        (e: any) => e.type === "custom" && e.customType === INGEST_MARKER
      );
      if (alreadyIngested) return; // skip — already ingested

      // Construct a generic auto-ingest summary
      const date = new Date().toISOString().split("T")[0];
      const summary = `## 会话复盘 — ${date}

> 🤖 自动兜底复盘（agent_end 触发）。本会话未调用 obs_ingest，由 agent_end hook 自动生成。

### 🎯 目标
会话执行中，未明确记录目标。

### ⚖️ 决策
未记录。

### 💡 收获
未记录。

### ⚠️ 遗留问题
未记录。
`;

      await ingest(summary, ctx);
    } catch (e: any) {
      console.error(`[pi-llm-wiki] Auto-ingest failed: ${e.message}`);
    }
  });
}
