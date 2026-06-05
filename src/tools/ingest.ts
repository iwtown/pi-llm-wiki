/**
 * pi-llm-wiki — obs-ingest tool.
 * Writes a session retrospective to raw/sessions/<project>/YYYY-MM-DD-<topic>.md
 * Extracts only: goals, decisions, insights, open issues. ≤500 words.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { writeFile, appendToFile } from "../client";
import { detectProject } from "../project";
import { PATHS, INGEST_MAX_CHARS } from "../config";

export async function ingest(
  content: string,
  ctx: ExtensionContext
): Promise<{ path: string; project: string }> {
  const project = detectProject(ctx.cwd ?? process.cwd());
  const projectName = project?.name ?? "unknown";
  const date = new Date().toISOString().split("T")[0];

  // Build safe filename from first line or topic
  const firstLine = content.split("\n")[0]?.replace(/^#+\s*/, "").trim() ?? "session";
  const safeTopic = firstLine.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, "-").slice(0, 60);
  const fileName = `${date}-${safeTopic || "session"}.md`;
  const dirPath = `${PATHS.rawSessions}/${projectName}`;
  const filePath = `${dirPath}/${fileName}`;

  // Extract session ID from context
  const sessionId = (ctx as any).sessionManager?.sessionId ?? "";

  // Ensure directory exists by writing the file (Obsidian API creates dirs)
  const template = `---
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

${content.slice(0, INGEST_MAX_CHARS)}
`;

  await writeFile(filePath, template);

  // Append to log.md
  const logLine = `## [${date}] ingest | ${projectName} — ${firstLine}`;
  try {
    await appendToFile(PATHS.log, logLine);
  } catch {
    // log write failure is non-fatal
  }

  return { path: filePath, project: projectName };
}
