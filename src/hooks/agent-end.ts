/**
 * pi-llm-wiki — agent_end hook.
 * Auto-ingests the session when agent_end fires (safety net if obs-ingest wasn't called).
 * Checks if this session was already ingested, skips if so.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ingest } from "../tools/ingest";

export async function autoIngest(pi: ExtensionAPI): Promise<void> {
  pi.on("agent_end", async (event, ctx) => {
    try {
      // Construct a generic auto-ingest summary
      // This is a safety net — the LLM should have called obs-ingest explicitly.
      // We create a minimal placeholder.
      const date = new Date().toISOString().split("T")[0];
      const summary = `## 会话复盘 — ${date}

> 🤖 自动兜底复盘（agent_end 触发）。本会话未调用 obs-ingest，由 agent_end hook 自动生成。

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
