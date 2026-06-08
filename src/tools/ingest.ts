/**
 * pi-llm-wiki — obs-ingest tool.
 * Writes a session retrospective to raw/sessions/<project>/YYYY-MM-DD-<topic>.md
 * Extracts only: goals, decisions, insights, open issues. ≤500 words.
 * Falls back to filesystem writes when Obsidian REST API is unavailable.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { writeFile, appendToFile, ping } from "../client";
import { detectProject } from "../project";
import { PATHS, INGEST_MAX_CHARS, LLM_WIKI } from "../config";

const VAULT_BASE = LLM_WIKI.vault;

function buildTemplate(
  firstLine: string,
  projectName: string,
  date: string,
  sessionId: string,
  content: string,
): string {
  return `---
title: "${firstLine}"
project: "${projectName}"
date: ${date}
session_id: "${sessionId}"
compiled: false
weaved: false
linted: false
tags: [session, ${projectName}]
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
    console.error(`[pi-llm-wiki] REST API write failed (${apiErr.message}), falling back to filesystem`);
  }

  // Fallback: write directly to vault filesystem
  try {
    const dir = path.dirname(fsPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fsPath, template, "utf-8");
    return "fs";
  } catch (fsErr: any) {
    console.error(`[pi-llm-wiki] Filesystem write also failed: ${fsErr.message}`);
    return "fail";
  }
}

export async function ingest(
  content: string,
  ctx: ExtensionContext
): Promise<{ path: string; project: string; writeMode: "api" | "fs" | "skip" }> {
  const project = detectProject(ctx.cwd ?? process.cwd());
  const projectName = project?.name ?? "unknown";
  const date = new Date().toISOString().split("T")[0];

  // Build safe filename from first meaningful line + timestamp to avoid collisions
  // B1 fix: skip leading YAML frontmatter (---) and empty lines
  const lines = content.split("\n").filter((l) => l.trim() && !l.trim().startsWith("---"));
  const firstLine = (lines[0] ?? "").replace(/^#+\s*/, "").trim() || "session";
  const safeTopic = firstLine.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, "-").slice(0, 50);
  // B3 fix: ensure safeTopic is non-empty for filename
  const safeTopicClean = safeTopic.trim() || "session";
  const time = new Date().toISOString().split("T")[1]?.replace(/:/g, "").slice(0, 6) ?? "";
  const fileName = `${date}-${safeTopicClean}-${time}.md`;
  const vaultPath = `${PATHS.rawSessions}/${projectName}/${fileName}`;
  const fsPath = path.join(VAULT_BASE, vaultPath);

  // Extract session ID from context
  const sessionId = (ctx as any).sessionManager?.sessionId ?? "";

  // G7: Check if this session was already ingested (dedup by session_id)
  if (sessionId) {
    const rawDir = path.join(VAULT_BASE, PATHS.rawSessions, projectName);
    try {
      const existing = fs.readdirSync(rawDir).filter((f) => f.endsWith(".md"));
      for (const f of existing) {
        const content = fs.readFileSync(path.join(rawDir, f), "utf-8");
        if (content.includes(`session_id: "${sessionId}"`)) {
          console.error(`[pi-llm-wiki] Session ${sessionId} already ingested, skipping`);
          return { path: vaultPath, project: projectName, writeMode: "skip" };
        }
      }
    } catch { /* dir may not exist yet */ }
  }

  // B2 fix: template already includes Task checkbox — no need to append again
  const template = buildTemplate(firstLine, projectName, date, sessionId, content);

  const writeMode = await writeWithFallback(vaultPath, fsPath, template);
  if (writeMode === "fail") {
    throw new Error(`Failed to write session to both API and filesystem: ${vaultPath}`);
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

  return { path: vaultPath, project: projectName, writeMode };
}
