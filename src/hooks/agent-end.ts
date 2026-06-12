/**
 * pi-llm-wiki — agent_end hook.
 * Auto-ingests the session when agent_end fires (safety net if obs_ingest wasn't called).
 * Integrates with pi-observational-memory to extract observations for meaningful auto-ingest.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ingest } from "../tools/ingest";
import { detectProject } from "../project";
import { LLM_WIKI } from "../config";
import { fileDlog, slog } from "../system/log";
import type { ExtendedContext } from "../types";

const VAULT = LLM_WIKI.vault;

export const INGEST_MARKER = "pi-llm-wiki:ingested";

// pi-observational-memory custom entry types
const OM_OBSERVATIONS_RECORDED = "om.observations.recorded";
const OM_REFLECTIONS_RECORDED = "om.reflections.recorded";

export interface OmObservation {
  id: string;
  content: string;
  timestamp: string;
  relevance: "low" | "medium" | "high" | "critical";
  sourceEntryIds: string[];
  tokenCount: number;
}

export interface OmReflection {
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

export function extractObservations(entries: any[]): { obs: OmObservation[]; refs: OmReflection[] } {
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

export function extractUserMessages(entries: any[]): string[] {
  const messages: string[] = [];
  for (const e of entries) {
    // Old format: type="user", message in e.message
    if (e.type === "user") {
      const text = extractMessageText(e.message ?? e);
      if (text) messages.push(text);
      continue;
    }
    // New format: type="message", role in e.message.role
    if (e.type === "message" && e.message?.role === "user") {
      const text = extractMessageText(e.message);
      if (text) messages.push(text);
    }
  }
  return messages;
}

export function extractMessageText(msg: any): string {
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
  if (content && typeof content === "object" && typeof (content as {text: string}).text === "string") {
    return (content as {text: string}).text;
  }
  return "";
}

// ── P2: Tiered summary builder ──

/** Tier 1: OM data available — structured output from observations/reflections
 *  Also injects original user messages for richer GLM extraction context. */
export function buildTier1Summary(
  obs: OmObservation[],
  refs: OmReflection[],
  userMessages: string[],
  date: string
): string {
  const meaningful = obs.filter((o) => o.relevance !== "low");
  const lines: string[] = [`## 会话复盘 — ${date}`, ""];
  lines.push("> 🤖 自动复盘（OM 数据 + 对话上下文）", "");

  // Inject the user's original goal for GLM extraction context
  if (userMessages.length > 0) {
    const goal = userMessages[0].length > 800
      ? userMessages[0].substring(0, 800) + "…"
      : userMessages[0];
    lines.push("### 🎯 目标", "");
    lines.push(goal, "");
  }

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
    for (const o of high.slice(0, 8)) lines.push(`- ${o.content}`);
    lines.push("");
  }
  if (medium.length > 0 && critical.length + high.length < 5) {
    lines.push("### 🔵 其他发现", "");
    for (const o of medium.slice(0, 5)) lines.push(`- ${o.content}`);
    lines.push("");
  }
  if (refs.length > 0) {
    lines.push("### 💡 反思洞察", "");
    for (const r of refs.slice(0, 8)) lines.push(`- ${r.content}`);
    lines.push("");
  }

  return lines.join("\n");
}

/** Tier 2: No OM — extract structure from raw user messages */
export function buildTier2Summary(userMessages: string[], date: string): string {
  const lines: string[] = [`## 会话复盘 — ${date}`, ""];
  lines.push("> 🤖 自动复盘（从用户消息提取）", "");

  // First message as goal (longer cap for GLM context)
  const goal = userMessages[0].length > 800
    ? userMessages[0].substring(0, 800) + "…"
    : userMessages[0];
  lines.push("### 🎯 目标", "");
  lines.push(goal, "");

  // Extract decisions and insights from non-first messages (avoid goal dup)
  const decisions: string[] = [];
  const insights: string[] = [];
  for (let i = 1; i < userMessages.length; i++) {
    const msg = userMessages[i];
    if (/决定|选择|采用|改成|配置|安装|弃用|改用/i.test(msg)) {
      decisions.push(`- ${msg.slice(0, 300)}`);
    }
    if (/发现|注意|陷阱|坑|理解|原因|教训/i.test(msg)) {
      insights.push(`- ${msg.slice(0, 300)}`);
    }
  }
  if (decisions.length > 0) {
    lines.push("### ⚖️ 决策", "");
    lines.push(...decisions.slice(0, 5), "");
  }
  if (insights.length > 0) {
    lines.push("### 💡 洞察", "");
    lines.push(...insights.slice(0, 5), "");
  }

  // Activity log (last 5 unique, dedup)
  const seen = new Set<string>();
  const activities: string[] = [];
  for (let i = userMessages.length - 1; i >= 0 && activities.length < 5; i--) {
    const short = userMessages[i].substring(0, 150);
    const key = short.toLowerCase().trim();
    if (!seen.has(key)) {
      seen.add(key);
      activities.unshift(`- ${short}${userMessages[i].length > 150 ? "…" : ""}`);
    }
  }
  if (activities.length > 0) {
    lines.push(`### 📋 活动 (${userMessages.length} 条消息)`, "");
    lines.push(...activities, "");
  }

  return lines.join("\n");
}

/** Unified summarizer: Tier 1 (OM + user msgs) → Tier 2 (extract) → skip */
export function buildUnifiedSummary(
  entries: any[],
  omData: { obs: OmObservation[]; refs: OmReflection[] }
): { summary: string | null; tier: string } {
  const userMessages = extractUserMessages(entries);
  if (userMessages.length === 0) return { summary: null, tier: "no-data" };

  const date = new Date().toISOString().split("T")[0];

  // Tier 1: High-value OM data available — use it
  const highValueObs = omData.obs.filter((o) => o.relevance === "critical" || o.relevance === "high");
  if (highValueObs.length > 0 || omData.refs.length > 0) {
    return { summary: buildTier1Summary(omData.obs, omData.refs, userMessages, date), tier: "tier1-om" };
  }

  // Tier 2: OM data too shallow (only medium/low) or none — extract from user messages
  // User message extraction often produces better results than shallow OM observations
  if (userMessages.length >= 2) {
    return { summary: buildTier2Summary(userMessages, date), tier: "tier2-extract" };
  }

  // Tier 3: Trivial — skip (ingest.ts scoreContent will also filter)
  return { summary: null, tier: "skip-trivial" };
}

export async function autoIngest(pi: ExtensionAPI): Promise<void> {
  pi.on("agent_end", async (event, ctx) => {
    const startTime = Date.now();
    fileDlog(`agent_end fired, sessionManager=${!!ctx.sessionManager}, getBranch=${typeof ctx.sessionManager?.getBranch}`);
    const sessionId = (ctx as ExtendedContext).sessionManager?.getSessionId?.() ?? "";
    try {
      // Check if obs_ingest was already called this session
      const entries = ctx.sessionManager?.getBranch?.() ?? [];
      fileDlog(`getBranch returned ${entries.length} entries`);
      const alreadyIngested = entries.some(
        (e: any) => e.type === "custom" && e.customType === INGEST_MARKER
      );
      fileDlog(`alreadyIngested=${alreadyIngested}`);
      if (alreadyIngested) return; // skip — explicit ingest was done

      // Skip trivial sessions: single user message with short user input AND few assistant responses
      const userMsgs = extractUserMessages(entries);
      const totalUserChars = userMsgs.reduce((sum, m) => sum + m.length, 0);
      const assistantCount = entries.filter((e: any) =>
        (e.type === "message" && e.message?.role === "assistant") ||
        (e.type === "assistant")
      ).length;
      const totalContentChars = entries.reduce((sum: number, e: any) => {
        const text = extractMessageText(e.message ?? e);
        return sum + (text?.length || 0);
      }, 0);

      if (userMsgs.length <= 1 && totalUserChars < 200 && assistantCount <= 3 && totalContentChars < 500) {
        fileDlog(`skip: trivial session (${userMsgs.length} user msgs, ${totalUserChars} user chars, ${assistantCount} assistant, ${totalContentChars} total chars)`);
        return;
      }

      // P2: Build summary using tiered approach (OM → extract → skip)
      const { obs, refs } = extractObservations(entries);
      fileDlog(`extracted obs=${obs.length} refs=${refs.length}`);
      const { summary, tier } = buildUnifiedSummary(entries, { obs, refs });
      fileDlog(`summary tier: ${tier}`);

      if (!summary) {
        fileDlog(`buildUnifiedSummary returned null (${tier}) — skipping`);
        return;
      }

      // Phase 1: Extract parentSessionId from context (for subagent fork detection)
      const extCtx = ctx as ExtendedContext;
      const parentSessionId = extCtx.parentSessionId ??
                              extCtx.forkParentId ??
                              "";
      if (parentSessionId) {
        fileDlog(`detected fork session, parentSessionId=${parentSessionId}`);
      }

      fileDlog(`calling ingest, summary length=${summary.length}, ctx.cwd=${ctx.cwd}`);
      await ingest(summary, { ...ctx, parentSessionId } as ExtendedContext);
      markIngested(pi); // set session marker so 2nd agent_end skips
      fileDlog(`ingest completed in ${Date.now() - startTime}ms`);
      const logProject = detectProject(ctx.cwd ?? process.cwd());
      slog("auto_ingest_ok", { project: logProject?.name ?? "unknown", sessionId, durationMs: Date.now() - startTime, hasOmData: obs.length > 0 || refs.length > 0 });
    } catch (e: any) {
      fileDlog(`Auto-ingest FAILED: ${e.message}`);
      if (e.stack) fileDlog(`Stack: ${e.stack}`);
      slog("auto_ingest_fail", { error: e.message, sessionId });
    }
  });
}
