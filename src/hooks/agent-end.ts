/**
 * pi-llm-wiki — agent_end hook.
 * Auto-ingests the session when agent_end fires (safety net if obs_ingest wasn't called).
 * Integrates with pi-observational-memory to extract observations for meaningful auto-ingest.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ingest, ingestedSessionIds } from "../tools/ingest";
import { compile } from "../tools/compile";
import { weave } from "../tools/weave";
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
    const sessionId = (ctx as ExtendedContext).sessionManager?.getSessionId?.() ?? "";
    const extCtx = ctx as ExtendedContext;
    const parentSessionId = extCtx.parentSessionId ?? extCtx.forkParentId ?? "";

    try {
      // ── Optimized flow: early exits before loading branch ──

      // [A] Fork child early skip: parent already ingested → child content is redundant
      if (parentSessionId && ingestedSessionIds.has(parentSessionId)) {
        markIngested(pi);
        slog("auto_ingest_fork_skip", { sessionId, parentSessionId });
        return;
      }

      // Load branch (lazy — skip tiny sessions without full traversal)
      const entries = ctx.sessionManager?.getBranch?.() ?? [];
      fileDlog(`getBranch returned ${entries.length} entries, parentSessionId=${parentSessionId || "-"}`);

      // [B] Tiny entry count → certainly trivial, skip immediately
      if (entries.length < 5) {
        fileDlog(`skip: tiny session (${entries.length} entries)`);
        return;
      }

      // Check ingested marker (explicit obs_ingest was already called)
      const alreadyIngested = entries.some(
        (e: any) => e.type === "custom" && e.customType === INGEST_MARKER
      );
      if (alreadyIngested) return;

      // Extract user messages + count assistant responses for triviality + summary
      const userMsgs = extractUserMessages(entries);
      const assistantCount = entries.filter((e: any) =>
        (e.type === "message" && e.message?.role === "assistant") ||
        (e.type === "assistant")
      ).length;

      // [C] Quick triviality check (O(1) after extraction)
      const totalUserChars = userMsgs.reduce((sum, m) => sum + m.length, 0);
      const totalContentChars = entries.reduce((sum: number, e: any) => {
        const text = extractMessageText(e.message ?? e);
        return sum + (text?.length || 0);
      }, 0);

      if (userMsgs.length <= 1 && totalUserChars < 200 && assistantCount <= 3 && totalContentChars < 500) {
        fileDlog(`skip: trivial session (${userMsgs.length} user msgs, ${totalUserChars} chars)`);
        slog("auto_ingest_trivial", { sessionId, userMsgs: userMsgs.length, totalChars: totalContentChars });
        return;
      }

      // [D] Conditional OM extraction — only for substantial sessions with assistant activity
      let obs: OmObservation[] = [];
      let refs: OmReflection[] = [];
      if (entries.length > 20 && assistantCount > 3) {
        const extracted = extractObservations(entries);
        obs = extracted.obs;
        refs = extracted.refs;
        fileDlog(`extracted obs=${obs.length} refs=${refs.length}`);
      }

      // Build summary (Tier 1: OM → Tier 2: extract → Tier 3: skip)
      const { summary, tier } = buildUnifiedSummary(entries, { obs, refs });
      fileDlog(`summary tier: ${tier}`);

      if (!summary) {
        fileDlog(`buildUnifiedSummary returned null (${tier}) — skipping`);
        return;
      }

      fileDlog(`calling ingest, summary length=${summary.length}, ctx.cwd=${ctx.cwd}`);
      const ingestResult = await ingest(summary, { ...ctx, parentSessionId } as ExtendedContext);
      markIngested(pi);
      fileDlog(`ingest completed in ${Date.now() - startTime}ms`);

      // ── Fire-and-forget incremental pipeline: compile → weave ──
      // Runs on next event loop tick so agent_end can return immediately.
      // compile writes to wiki/, weave adds backlinks.
      // lint is deliberately excluded (full-scan, better as periodic manual step).
      if (ingestResult.writeMode !== "skip" && ingestResult.path) {
        setImmediate(async () => {
          try {
            const cr = await compile(ingestResult.path, {}, ctx);
            if (cr?.wikiPath && cr.linkedTo?.length) {
              await weave(ingestResult.path, cr.wikiPath, cr.linkedTo, cr.insights, ctx);
            }
          } catch (e: any) {
            slog("pipeline_error", { path: ingestResult.path, error: e.message });
          }
        });
      }

      const logProject = detectProject(ctx.cwd ?? process.cwd());
      slog("auto_ingest_ok", {
        project: logProject?.name ?? "unknown",
        sessionId,
        durationMs: Date.now() - startTime,
        hasOmData: obs.length > 0 || refs.length > 0,
      });

      if (ctx.hasUI && logProject?.name) {
        ctx.ui?.notify(`📝 已自动复盘此会话 → ${logProject.name}`, "info");
      }
    } catch (e: any) {
      fileDlog(`Auto-ingest FAILED: ${e.message}`);
      if (e.stack) fileDlog(`Stack: ${e.stack}`);
      slog("auto_ingest_fail", { error: e.message, sessionId, stack: e.stack });
    }
  });
}
