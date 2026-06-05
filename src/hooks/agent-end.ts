/**
 * pi-llm-wiki — agent_end hook.
 * Auto-ingests the session when agent_end fires (safety net if obs_ingest wasn't called).
 * Integrates with pi-observational-memory to extract observations for meaningful auto-ingest.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ingest } from "../tools/ingest";

const INGEST_MARKER = "pi-llm-wiki:ingested";

// pi-observational-memory custom entry types
const OM_OBSERVATIONS_RECORDED = "om.observations.recorded";
const OM_REFLECTIONS_RECORDED = "om.reflections.recorded";

interface OmObservation {
  id: string;
  content: string;
  timestamp: string;
  relevance: "low" | "medium" | "high" | "critical";
  sourceEntryIds: string[];
  tokenCount: number;
}

interface OmReflection {
  id: string;
  content: string;
  supportingObservationIds: string[];
  tokenCount: number;
}

export function markIngested(pi: ExtensionAPI): void {
  try {
    pi.appendEntry(INGEST_MARKER, { timestamp: Date.now() });
  } catch {
    // non-fatal
  }
}

function extractObservations(entries: any[]): { obs: OmObservation[]; refs: OmReflection[] } {
  const obs: OmObservation[] = [];
  const refs: OmReflection[] = [];
  for (const e of entries) {
    if (e.type === "custom" && e.customType === OM_OBSERVATIONS_RECORDED && e.data?.observations) {
      obs.push(...e.data.observations);
    }
    if (e.type === "custom" && e.customType === OM_REFLECTIONS_RECORDED && e.data?.reflections) {
      refs.push(...e.data.reflections);
    }
  }
  return { obs, refs };
}

function buildAutoSummary(obs: OmObservation[], refs: OmReflection[]): string | null {
  const meaningful = obs.filter((o) => o.relevance !== "low");
  if (meaningful.length === 0 && refs.length === 0) return null;

  const date = new Date().toISOString().split("T")[0];
  const lines: string[] = [`## 会话复盘 — ${date}`, ""];

  lines.push("> 🤖 自动兜底复盘（agent_end + pi-observational-memory）", "");

  // Observations by relevance
  const critical = meaningful.filter((o) => o.relevance === "critical");
  const high = meaningful.filter((o) => o.relevance === "high");
  const medium = meaningful.filter((o) => o.relevance === "medium");

  if (critical.length > 0) {
    lines.push("### 🔴 关键发现", "");
    for (const o of critical) lines.push(`- ${o.content}`);
    lines.push("");
  }
  if (high.length > 0) {
    lines.push("### 🟡 重要观察", "");
    for (const o of high.slice(0, 5)) lines.push(`- ${o.content}`);
    lines.push("");
  }
  if (medium.length > 0 && critical.length + high.length < 5) {
    lines.push("### 🔵 其他发现", "");
    for (const o of medium.slice(0, 3)) lines.push(`- ${o.content}`);
    lines.push("");
  }

  // Reflections (higher-level insights)
  if (refs.length > 0) {
    lines.push("### 💡 反思洞察", "");
    for (const r of refs.slice(0, 5)) lines.push(`- ${r.content}`);
    lines.push("");
  }

  lines.push("### ⚠️ 注意", "");
  lines.push("本复盘由 agent_end 自动生成，可能缺少人工标注的目标和决策。");

  return lines.join("\n");
}

export async function autoIngest(pi: ExtensionAPI): Promise<void> {
  pi.on("agent_end", async (event, ctx) => {
    try {
      // Check if obs_ingest was already called this session
      const entries = ctx.sessionManager?.getEntries?.() ?? [];
      const alreadyIngested = entries.some(
        (e: any) => e.type === "custom" && e.customType === INGEST_MARKER
      );
      if (alreadyIngested) return; // skip — explicit ingest was done

      // Try to build summary from pi-observational-memory
      const { obs, refs } = extractObservations(entries);
      const summary = buildAutoSummary(obs, refs);

      if (!summary) {
        // No meaningful observations — skip entirely instead of creating empty shell
        return;
      }

      await ingest(summary, ctx);
    } catch (e: any) {
      console.error(`[pi-llm-wiki] Auto-ingest failed: ${e.message}`);
    }
  });
}
