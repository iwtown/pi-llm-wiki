/**
 * pi-llm-wiki — obs-ingest tool.
 * Writes a session retrospective to raw/sessions/<project>/YYYY-MM-DD-<topic>.md
 * Extracts only: goals, decisions, insights, open issues. ≤500 words.
 * Falls back to filesystem writes when Obsidian REST API is unavailable.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtendedContext } from "../types";
import { writeFile, appendToFile } from "../client";
import { detectProject } from "../project";
import { PATHS, INGEST_MAX_CHARS, LLM_WIKI } from "../config";
import { logChange } from "../system/changes";
import { dlog, slog } from "../system/log";
import { parseFrontmatter } from "../system/parse";

const VAULT_BASE = LLM_WIKI.vault;

// ── Session ID dedup cache (built at before_start, updated at ingest) ──

export const ingestedSessionIds = new Set<string>();

/** Build session ID index from all existing raw session files */
export function buildIngestedIndex(vaultBase: string): void {
  ingestedSessionIds.clear();
  const rawDir = path.join(vaultBase, PATHS.rawSessions);
  try {
    for (const proj of fs.readdirSync(rawDir)) {
      const projDir = path.join(rawDir, proj);
      if (!fs.statSync(projDir).isDirectory()) continue;
      for (const f of fs.readdirSync(projDir)) {
        if (!f.endsWith(".md")) continue;
        const content = fs.readFileSync(path.join(projDir, f), "utf-8");
        const fm = parseFrontmatter(content);
        if (typeof fm.session_id === "string" && fm.session_id) {
          ingestedSessionIds.add(fm.session_id);
        }
      }
    }
    dlog(`Ingested session index built: ${ingestedSessionIds.size} entries`);
  } catch {
    // non-fatal; index will be rebuilt at next startup
  }
}

// ── Phase 4: Session quality scoring ──

export interface SessionScore {
  score: number; // 0-100
  isTrivial: boolean; // score < 30
  factors: {
    hasGoal: boolean;
    hasDecisions: boolean;
    hasInsights: boolean;
    hasIssues: boolean;
    totalChars: number;
    sectionCount: number;
  };
}

/** Score session content quality on a 0-100 scale */
export function scoreContent(content: string): SessionScore {
  const body = content;
  const totalChars = body.length;

  // Check for structured sections
  const hasGoal = /### 🎯/.test(body);
  const hasDecisions = /### ⚖️|决定|选择|采用|配置|安装/.test(body);
  const hasInsights = /### 💡|发现|注意|陷阱|洞察|教训/.test(body);
  const hasIssues = /### ⚠️|遗留|问题|todo|TODO/.test(body);
  const sectionCount = [hasGoal, hasDecisions, hasInsights, hasIssues].filter(Boolean).length;

  // Scoring algorithm
  let score = 0;

  // Content volume
  if (totalChars > 300) score += 10;
  if (totalChars > 800) score += 10;
  if (totalChars > 2000) score += 10;

  // Structured sections (each adds value)
  if (hasGoal) score += 15;
  if (hasDecisions) score += 20;
  if (hasInsights) score += 15;
  if (hasIssues) score += 10;

  // Multiple sections = richer content
  if (sectionCount >= 2) score += 10;
  if (sectionCount >= 3) score += 10;

  return {
    score: Math.min(100, score),
    isTrivial: score < 45,
    factors: { hasGoal, hasDecisions, hasInsights, hasIssues, totalChars, sectionCount },
  };
}

function buildTemplate(
  firstLine: string,
  projectName: string,
  date: string,
  sessionId: string,
  content: string,
  sessionScore: number,
  isTrivial: boolean,
  parentSessionId?: string,
): string {
  const tagSuffix = parentSessionId ? ", fork-session" : "";
  const parentField = parentSessionId ? `parent_session_id: "${parentSessionId}"` : "";
  return `---
title: "${firstLine}"
project: "${projectName}"
date: ${date}
session_id: "${sessionId}"
${parentField}
session_score: ${sessionScore}
trivial: ${isTrivial}
compiled: false
weaved: false
linted: false
tags: [session, ${projectName}${tagSuffix}]
---

# ${firstLine}

- [ ] 编译: ${firstLine} 📅 ${date}

${content.slice(0, INGEST_MAX_CHARS)}
`;
}

/** Write template via REST API, falling back to filesystem on failure */
async function writeWithFallback(
  vaultPath: string,
  fsPath: string,
  template: string,
): Promise<"api" | "fs" | "fail"> {
  // Try REST API first
  try {
    await writeFile(vaultPath, template);
    return "api";
  } catch (apiErr: any) {
    dlog(`REST API write failed (${apiErr.message}), falling back to filesystem`);
  }

  // Fallback: write directly to vault filesystem
  try {
    const dir = path.dirname(fsPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fsPath, template, "utf-8");
    return "fs";
  } catch (fsErr: any) {
    dlog(`Filesystem write also failed: ${fsErr.message}`);
    return "fail";
  }
}

/** Check if the parent session (or its direct child) has already been ingested */
function checkParentIngested(parentSessionId: string): boolean {
  return ingestedSessionIds.has(parentSessionId);
}

export async function ingest(
  content: string,
  ctx: ExtensionContext
): Promise<{ path: string; project: string; writeMode: "api" | "fs" | "skip" }> {
  const project = detectProject(ctx.cwd ?? process.cwd());
  const projectName = project?.name ?? "unknown";
  const date = new Date().toISOString().split("T")[0];

  // Extract parentSessionId from context (for subagent fork detection)
  const parentSessionId = (ctx as ExtendedContext).parentSessionId ?? "";

  // Phase 1: Fork detection — if this is a subagent fork, check if parent already ingested
  if (parentSessionId) {
    if (checkParentIngested(parentSessionId)) {
      dlog(`Fork session (parent=${parentSessionId}): skipped (parent already ingested)`);
      return { path: "", project: projectName, writeMode: "skip" };
    }
  }

  // Phase 4: Score session content quality — skip trivial sessions
  const contentLines = content.split("\n").filter((l) => l.trim() && !l.trim().startsWith("---"));
  const topicLine = (contentLines[0] ?? "").replace(/^#+\s*/, "").trim() || "session";
  const score = scoreContent(content);
  if (score.isTrivial) {
    slog("ingest_trivial_skip", { score: score.score, project: projectName, topic: topicLine.slice(0, 60) });
    return { path: "", project: projectName, writeMode: "skip" };
  }

  // Extract session ID from context
  const sessionId = (ctx as ExtendedContext).sessionManager?.getSessionId?.() ?? "";

  // Build stable filename: session_id short prefix for collision-free naming + topic for readability
  const firstLine = topicLine;
  const sessionIdShort = sessionId ? sessionId.split("-")[0] || sessionId.slice(-8) : "";
  const idPrefix = sessionIdShort ? `${sessionIdShort}-` : "";
  const safeTopic = firstLine.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, "-").slice(0, 50);
  const safeTopicClean = safeTopic.trim() || "session";
  const time = new Date().toISOString().split("T")[1]?.replace(/:/g, "").slice(0, 6) ?? "";
  const fileName = `${date}-${idPrefix}${safeTopicClean}-${time}.md`;
  const vaultPath = `${PATHS.rawSessions}/${projectName}/${fileName}`;
  const fsPath = path.join(VAULT_BASE, vaultPath);

  // Session ID dedup: check in-memory index (built at before_start, O(1))
  if (sessionId && ingestedSessionIds.has(sessionId)) {
    dlog(`Session ${sessionId} already ingested (from index), skipping`);
    return { path: vaultPath, project: projectName, writeMode: "skip" };
  }

  // B2 fix: template already includes Task checkbox — no need to append again
  const template = buildTemplate(firstLine, projectName, date, sessionId, content, score.score, score.isTrivial, parentSessionId || undefined);

  const writeMode = await writeWithFallback(vaultPath, fsPath, template);
  if (writeMode === "fail") {
    throw new Error(`Failed to write session to both API and filesystem: ${vaultPath}`);
  }

  // Update in-memory index (avoids re-scan on duplicate agent_end or re-ingest)
  if (sessionId) {
    ingestedSessionIds.add(sessionId);
  }

  // Append to log.md
  const logLine = `## [${date}] ingest | ${projectName} — ${firstLine}`;
  const logVaultPath = PATHS.log;
  const logFsPath = path.join(VAULT_BASE, logVaultPath);
  try {
    await appendToFile(logVaultPath, logLine);
  } catch {
    // Fallback: append to log via filesystem
    try {
      const existing = fs.existsSync(logFsPath)
        ? fs.readFileSync(logFsPath, "utf-8")
        : "";
      const updated = existing + (existing && !existing.endsWith("\n") ? "\n" : "") + logLine + "\n";
      fs.writeFileSync(logFsPath, updated, "utf-8");
    } catch {
      // log write failure is non-fatal
    }
  }

  // Phase 3: Log change for incremental processing (skip path returns early above)
  logChange({ type: "ingest", path: vaultPath, action: "create", timestamp: date });

  return { path: vaultPath, project: projectName, writeMode };
}
