/**
 * pi-llm-wiki — agent_end hook.
 * Auto-ingests the session when agent_end fires (safety net if obs_ingest wasn't called).
 * Integrates with pi-observational-memory to extract observations for meaningful auto-ingest.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { ingest } from "../tools/ingest";
import { detectProject } from "../project";
import { LLM_WIKI, PATHS } from "../config";

const VAULT = LLM_WIKI.vault;

const DEBUG_LOG = path.join(
  process.env.HOME ?? "/home",
  ".pi/agent/pi-llm-wiki-debug.log"
);
const STRUCTURED_LOG = path.join(
  process.env.HOME ?? "/home",
  ".pi/agent/pi-llm-wiki.log"
);
const SLOG_MAX_BYTES = 1_000_000; // 1MB rotation threshold

// In-memory cache to avoid vault filesystem scan on every agent_end
const ingestedSessionIds = new Set<string>();

function dlog(msg: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  fs.appendFileSync(DEBUG_LOG, `${line}\n`);
  console.error(`[pi-llm-wiki:DEBUG] ${msg}`);
}

/** Structured log entry for machine parsing, with rotation */
function slog(event: string, data: Record<string, unknown> = {}): void {
  const ts = new Date().toISOString();
  const entry = JSON.stringify({ ts, event, ...data });
  try {
    // Rotate if over 1MB
    if (fs.existsSync(STRUCTURED_LOG)) {
      const stat = fs.statSync(STRUCTURED_LOG);
      if (stat.size > SLOG_MAX_BYTES) {
        for (let i = 2; i >= 0; i--) {
          const oldPath = `${STRUCTURED_LOG}.${i}`;
          const newPath = `${STRUCTURED_LOG}.${i + 1}`;
          if (fs.existsSync(oldPath)) fs.renameSync(oldPath, newPath);
        }
        fs.renameSync(STRUCTURED_LOG, `${STRUCTURED_LOG}.0`);
      }
    }
    fs.appendFileSync(STRUCTURED_LOG, entry + "\n");
  } catch {
    // non-fatal
  }
}

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

function extractUserMessages(entries: any[]): string[] {
  const messages: string[] = [];
  for (const e of entries) {
    if (e.type !== "user") continue;
    const text = extractMessageText(e.message ?? e);
    if (text) messages.push(text);
  }
  return messages;
}

function extractMessageText(msg: any): string {
  if (!msg) return "";
  if (typeof msg === "string") return msg;
  // content can be string | ContentBlock[] | {text: string} | {content: ...}
  const content = msg.content ?? msg.text ?? msg.message;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b && (b.type === "text" || b.type === "input_text"))
      .map((b: any) => b.text)
      .join(" ");
  }
  if (content && typeof content === "object" && typeof (content as any).text === "string") {
    return (content as any).text;
  }
  return "";
}

function buildFallbackSummary(entries: any[]): string | null {
  const userMessages = extractUserMessages(entries);
  if (userMessages.length === 0) return null;

  const date = new Date().toISOString().split("T")[0];
  const lines: string[] = [`## 会话复盘 — ${date}`, ""];
  lines.push("> 🤖 自动兜底复盘（agent_end fallback — OM 数据不可用，从原始用户消息提取）", "");

  // First user message → session goal
  const maxLen = 300;
  const goal = userMessages[0].length > maxLen ? userMessages[0].substring(0, maxLen) + "..." : userMessages[0];
  lines.push("### 🎯 会话主题", "");
  lines.push(goal, "");

  // Remaining user messages → activity log (last 10, dedup short)
  const remaining = userMessages.slice(1);
  if (remaining.length > 0) {
    const seen = new Set<string>();
    const activities: string[] = [];
    for (let i = remaining.length - 1; i >= 0 && activities.length < 10; i--) {
      const short = remaining[i].substring(0, 150);
      const key = short.toLowerCase().trim();
      if (!seen.has(key)) {
        seen.add(key);
        activities.unshift(`- ${remaining[i].length > 150 ? short + "..." : short}`);
      }
    }
    if (activities.length > 0) {
      lines.push(`### 📋 会话活动 (${userMessages.length} 条用户消息)`, "");
      lines.push(...activities, "");
    }
  }

  lines.push("### ⚠️ 注意", "");
  lines.push("本复盘由 agent_end 自动生成（OM 数据不可用回退），可能缺少结构化目标和决策。");

  return lines.join("\n");
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
    const startTime = Date.now();
    const sessionId = (ctx as any).sessionManager?.sessionId ?? "";
    dlog(`agent_end fired, sessionManager=${!!ctx.sessionManager}, getBranch=${typeof ctx.sessionManager?.getBranch}`);
    try {
      // Check if obs_ingest was already called this session
      const entries = ctx.sessionManager?.getBranch?.() ?? [];
      dlog(`getBranch returned ${entries.length} entries`);
      const alreadyIngested = entries.some(
        (e: any) => e.type === "custom" && e.customType === INGEST_MARKER
      );
      dlog(`alreadyIngested=${alreadyIngested}`);
      if (alreadyIngested) return; // skip — explicit ingest was done

      // G3: Use in-memory cache instead of vault filesystem scan
      if (ingestedSessionIds.has(sessionId)) {
        dlog(`skip: session ${sessionId} in memory cache`);
        return;
      }

      // G5: Skip trivial sessions (≤1 user message, <200 chars total)
      const userMsgs = extractUserMessages(entries);
      const totalUserChars = userMsgs.reduce((sum, m) => sum + m.length, 0);
      if (userMsgs.length <= 1 && totalUserChars < 200) {
        dlog(`skip: trivial session (${userMsgs.length} msgs, ${totalUserChars} chars)`);
        ingestedSessionIds.add(sessionId); // don't recheck
        return;
      }

      // Try to build summary from pi-observational-memory
      const { obs, refs } = extractObservations(entries);
      dlog(`extracted obs=${obs.length} refs=${refs.length}`);
      let summary = buildAutoSummary(obs, refs);

      if (!summary) {
        dlog(`buildAutoSummary returned null (OM data empty) — trying fallback from raw user messages`);
        summary = buildFallbackSummary(entries);
      }

      if (!summary) {
        dlog(`buildFallbackSummary also returned null — skipping (no user messages found)`);
        return;
      }

      dlog(`calling ingest, summary length=${summary.length}, ctx.cwd=${ctx.cwd}`);
      await ingest(summary, ctx);
      ingestedSessionIds.add(sessionId);
      dlog(`ingest completed in ${Date.now() - startTime}ms`);
      const logProject = detectProject(ctx.cwd ?? process.cwd());
      slog("auto_ingest_ok", { project: logProject?.name ?? "unknown", sessionId, durationMs: Date.now() - startTime, hasOmData: obs.length > 0 || refs.length > 0 });
    } catch (e: any) {
      dlog(`Auto-ingest FAILED: ${e.message}`);
      if (e.stack) dlog(`Stack: ${e.stack}`);
      slog("auto_ingest_fail", { error: e.message, sessionId });
    }
  });
}
