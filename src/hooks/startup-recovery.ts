/**
 * pi-llm-wiki — startup orphan session recovery hook.
 * Scans ~/.pi/agent/sessions/ for sessions that never triggered agent_end
 * (crashes, kills, freezes) and writes fallback summaries directly to the
 * Obsidian vault filesystem.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { detectProject } from "../project";
import { PATHS, INGEST_MAX_CHARS, LLM_WIKI } from "../config";
import { dlog } from "../system/log";

const INGEST_MARKER = "pi-llm-wiki:ingested";
const PROCESSED_FILE = path.join(
  process.env.HOME ?? "/home",
  ".pi/agent/.pi-llm-wiki-recovery-processed"
);
const SESSIONS_DIR = path.join(
  process.env.HOME ?? "/home",
  ".pi/agent/sessions"
);
const VAULT_BASE = LLM_WIKI.vault;

function getProcessedIds(): Set<string> {
  try {
    const data = fs.readFileSync(PROCESSED_FILE, "utf-8");
    return new Set(data.split("\n").map((l) => l.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

function markProcessed(ids: string[]): void {
  if (ids.length === 0) return;
  try {
    const dir = path.dirname(PROCESSED_FILE);
    fs.mkdirSync(dir, { recursive: true });
    const existing = getProcessedIds();
    for (const id of ids) existing.add(id);
    fs.writeFileSync(PROCESSED_FILE, [...existing].join("\n") + "\n", "utf-8");
  } catch {
    // non-fatal
  }
}

/** Parse JSONL lines, extracting user messages and checking for ingest marker */
function parseSession(jsonlPath: string): {
  hasIngestMarker: boolean;
  userMessages: string[];
} {
  let hasIngestMarker = false;
  const userMessages: string[] = [];

  try {
    const raw = fs.readFileSync(jsonlPath, "utf-8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(trimmed);
      } catch {
        continue;
      }

      // Check for ingest marker
      if (entry.type === "custom" && entry.customType === INGEST_MARKER) {
        hasIngestMarker = true;
      }

      // Extract user messages (old format: type="user", new format: type="message", role="user")
      const entryAny = entry as Record<string, unknown>;
      if (entry.type === "user") {
        const text = extractText(entryAny.message ?? entry);
        if (text) userMessages.push(text);
      } else if (entry.type === "message" && (entryAny.message as Record<string, unknown>)?.role === "user") {
        const text = extractText(entry.message);
        if (text) userMessages.push(text);
      }
    }
  } catch {
    // Can't read file — skip
  }

  return { hasIngestMarker, userMessages };
}

function extractText(msg: unknown): string {
  if (!msg) return "";
  if (typeof msg === "string") return msg;
  const msgObj = msg as Record<string, unknown>;
  const content = msgObj.content ?? msgObj.text ?? msgObj.message;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: unknown): b is { type: string; text: string } =>
        b !== null && typeof b === "object" && "type" in (b as Record<string, unknown>) && "text" in (b as Record<string, unknown>)
      )
      .map((b) => b.text)
      .join(" ");
  }
  if (content && typeof content === "object" && typeof (content as {text: string}).text === "string") {
    return (content as {text: string}).text;
  }
  return "";
}

function buildSummary(userMessages: string[], sessionId: string): string {
  const date = new Date().toISOString().split("T")[0];
  const lines: string[] = [
    `## 💥 崩溃恢复复盘 — ${date}`,
    "",
    "> 🤖 启动时发现未摄入的孤儿 session（Pi 进程异常退出），自动从原始消息提取。",
    "",
    "### 🎯 会话主题",
    "",
  ];

  const maxLen = 300;
  const goal =
    userMessages[0].length > maxLen
      ? userMessages[0].substring(0, maxLen) + "..."
      : userMessages[0];
  lines.push(goal, "");

  const remaining = userMessages.slice(1);
  if (remaining.length > 0) {
    const seen = new Set<string>();
    const activities: string[] = [];
    for (let i = remaining.length - 1; i >= 0 && activities.length < 10; i--) {
      const short = remaining[i].substring(0, 150);
      const key = short.toLowerCase().trim();
      if (!seen.has(key)) {
        seen.add(key);
        activities.unshift(
          `- ${remaining[i].length > 150 ? short + "..." : short}`
        );
      }
    }
    if (activities.length > 0) {
      lines.push(
        `### 📋 会话活动 (${userMessages.length} 条用户消息)`,
        "",
        ...activities,
        ""
      );
    }
  }

  lines.push("### ⚠️ 注意", "");
  lines.push(
    "这是崩溃恢复复盘，由 agent_start 扫描孤儿 session 自动生成。可能缺少结构化目标和决策。",
    `原始 session: \`${sessionId}\``
  );

  return lines.join("\n");
}

/** Derive project name from session directory name */
function deriveProject(sessionDir: string): string {
  // Directory name encodes cwd: --home-wtown-projects-pi--
  const name = path.basename(sessionDir);
  const cwdLike = name.replace(/^--/, "").replace(/--$/, "").replace(/-/g, "/");
  const cwd = `/${cwdLike}`;
  const project = detectProject(cwd);
  return project?.name ?? path.basename(sessionDir);
}

/** Write content directly to Obsidian vault filesystem */
function writeToVault(
  projectName: string,
  sessionId: string,
  content: string
): boolean {
  const date = new Date().toISOString().split("T")[0];
  const safeName = `crash-recovery-${sessionId.slice(0, 8)}`;
  const dirPath = path.join(VAULT_BASE, PATHS.rawSessions, projectName);
  const filePath = path.join(dirPath, `${date}-${safeName}.md`);

  const firstLine = content.split("\n")[0]?.replace(/^#+\s*/, "").trim() ?? "崩溃恢复";
  const template = `---
title: "${firstLine}"
project: "${projectName}"
date: ${date}
session_id: "${sessionId}"
compiled: false
weaved: false
linted: false
tags: [session, ${projectName}, crash-recovery]
---

${content.slice(0, INGEST_MAX_CHARS)}
`;

  try {
    fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(filePath, template, "utf-8");
    dlog(`wrote crash recovery: ${filePath}`);
    return true;
  } catch (e: any) {
    dlog(`failed to write ${filePath}: ${e.message}`);
    return false;
  }
}

/** Scan sessions directory for unprocessed sessions (not in processed set) */
function findOrphanSessions(processed: Set<string>): string[] {
  const orphans: string[] = [];

  let projectDirs: string[];
  try {
    projectDirs = fs.readdirSync(SESSIONS_DIR);
  } catch {
    return orphans;
  }

  for (const dir of projectDirs) {
    const dirPath = path.join(SESSIONS_DIR, dir);
    if (!fs.statSync(dirPath).isDirectory()) continue;

    // M4: Skip non-Pi session directories. Pi dirs match --<cwd>-- pattern.
    if (!dir.startsWith("--") || !dir.endsWith("--")) {
      dlog(`skip non-Pi dir: ${dir}`);
      continue;
    }

    let sessionFiles: string[];
    try {
      sessionFiles = fs.readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }

    for (const file of sessionFiles) {
      // Use basename (without .jsonl) as session identifier
      const sessionId = file.replace(/\.jsonl$/, "");
      if (processed.has(sessionId)) continue;
      orphans.push(path.join(dirPath, file));
    }
  }

  return orphans;
}

export function registerStartupRecovery(pi: ExtensionAPI): void {
  pi.on("agent_start", async (_event, _ctx) => {
    const processed = getProcessedIds();
    dlog(`startup recovery scan, processed=${processed.size}`);

    const orphans = findOrphanSessions(processed);
    dlog(`found ${orphans.length} unprocessed sessions`);

    let recovered = 0;
    let skipped = 0;
    const newlyProcessed: string[] = [];

    for (const jsonlPath of orphans) {
      const sessionId = path.basename(jsonlPath, ".jsonl");
      const sessionDir = path.basename(path.dirname(jsonlPath));

      // Always mark as processed so we don't rescan
      newlyProcessed.push(sessionId);

      const { hasIngestMarker, userMessages } = parseSession(jsonlPath);

      if (hasIngestMarker) {
        dlog(`skip ${sessionId}: already has ingest marker`);
        skipped++;
        continue;
      }

      if (userMessages.length === 0) {
        dlog(`skip ${sessionId}: no user messages`);
        skipped++;
        continue;
      }

      const projectName = deriveProject(sessionDir);
      const summary = buildSummary(userMessages, sessionId);

      if (writeToVault(projectName, sessionId, summary)) {
        recovered++;
      }
    }

    markProcessed(newlyProcessed);
    dlog(
      `startup recovery complete: ${recovered} recovered, ${skipped} skipped, ${newlyProcessed.length} marked`
    );
  });
}
