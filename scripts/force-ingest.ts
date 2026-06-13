/**
 * pi-llm-wiki — Force-ingest missed sessions from JSONL source.
 * Reads Pi session JSONL files directly, builds Tier 2 summaries, and writes
 * to raw/sessions/<project>/ for subsequent pipeline processing.
 *
 * Usage:
 *   npx tsx scripts/force-ingest.ts
 *   PROJECT=pi npx tsx scripts/force-ingest.ts       # specific project name
 *   SESSION_DIR=... npx tsx scripts/force-ingest.ts   # custom session dir
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { LLM_WIKI, PATHS, INGEST_MAX_CHARS } from "../src/config";

const VAULT = LLM_WIKI.vault;
const SESSIONS_DIR = process.env.SESSION_DIR || path.join(process.env.HOME || "/home", ".pi/agent/sessions");
const TARGET_PROJECT = process.env.PROJECT || "pi";
const MIN_ENTRIES = 20;  // skip tiny sessions

interface SessionInfo {
  filePath: string;
  sessionId: string;
  timestamp: string;
  project: string;
  entries: number;
  userMessages: string[];
  userMessageCount: number;
}

function extractMessages(jsonlPath: string): { userMessages: string[]; entries: number } {
  const userMessages: string[] = [];
  let entries = 0;

  try {
    const raw = fs.readFileSync(jsonlPath, "utf-8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let entry: any;
      try {
        entry = JSON.parse(trimmed);
      } catch {
        continue;
      }
      entries++;

      // Extract user messages
      if (entry.type === "user") {
        const text = extractText(entry.message ?? entry);
        if (text) userMessages.push(text);
      } else if (entry.type === "message" && entry.message?.role === "user") {
        const text = extractText(entry.message);
        if (text) userMessages.push(text);
      }
    }
  } catch {
    // Can't read
  }

  return { userMessages, entries };
}

function extractText(msg: any): string {
  if (!msg) return "";
  if (typeof msg === "string") return msg;
  const content = msg.content ?? msg.text ?? msg.message;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b && (b.type === "text" || b.type === "input_text"))
      .map((b: any) => b.text)
      .join(" ");
  }
  if (content && typeof content === "object" && typeof content.text === "string") {
    return content.text;
  }
  return "";
}

function buildTier2Summary(userMessages: string[]): string {
  const lines: string[] = ["## 会话复盘", ""];
  lines.push("> 🤖 强制摄入 — 从原始消息提取", "");

  // Goal = first message
  const goal = userMessages[0].length > 800
    ? userMessages[0].substring(0, 800) + "…"
    : userMessages[0];
  lines.push("### 🎯 目标", "");
  lines.push(goal, "");

  // Decisions and insights
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

  // Activities
  const seen = new Set<string>();
  const activities: string[] = [];
  for (let i = userMessages.length - 1; i >= 0 && activities.length < 8; i--) {
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

function scoreContent(content: string): number {
  let score = 0;
  const totalChars = content.length;
  if (totalChars > 300) score += 10;
  if (totalChars > 800) score += 10;
  if (totalChars > 2000) score += 10;
  if (/### 🎯/.test(content)) score += 15;
  if (/### ⚖️|决定|选择|采用|配置|安装/.test(content)) score += 20;
  if (/### 💡|发现|注意|陷阱|洞察|教训/.test(content)) score += 15;
  if (/### ⚠️|遗留|问题|todo/i.test(content)) score += 10;
  return Math.min(100, score);
}

function writeRawFile(project: string, sessionId: string, topic: string, content: string): string | null {
  const date = new Date().toISOString().split("T")[0];
  const safeTopic = topic.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, "-").slice(0, 50).trim() || "session";
  const time = new Date().toISOString().split("T")[1]?.replace(/:/g, "").slice(0, 6) || "";
  const fileName = `${date}-${safeTopic}-${time}.md`;
  const vaultPath = `${PATHS.rawSessions}/${project}/${fileName}`;
  const fsPath = path.join(VAULT, vaultPath);

  const score = scoreContent(content);
  const template = `---
title: "${topic}"
project: "${project}"
date: ${date}
session_id: "${sessionId}"
session_score: ${score}
trivial: false
compiled: false
weaved: false
linted: false
tags: [session, ${project}, force-ingested]
---

${content.slice(0, INGEST_MAX_CHARS)}
`;

  try {
    fs.mkdirSync(path.dirname(fsPath), { recursive: true });
    fs.writeFileSync(fsPath, template, "utf-8");
    return vaultPath;
  } catch (e: any) {
    console.error(`  ❌ Failed to write: ${e.message}`);
    return null;
  }
}

// ─── Main ───

async function main() {
  const projectDirs = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith("--"));

  const missedSessions: SessionInfo[] = [];

  for (const dir of projectDirs) {
    const dirPath = path.join(SESSIONS_DIR, dir.name);
    const files = fs.readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));

    for (const file of files) {
      const jsonlPath = path.join(dirPath, file);
      const sessionId = file.replace(/\.jsonl$/, "");

      // Skip if already ingested (check all raw projects)
      let alreadyDone = false;
      try {
        const rawProjects = fs.readdirSync(path.join(VAULT, PATHS.rawSessions));
        for (const proj of rawProjects) {
          const projDir = path.join(VAULT, PATHS.rawSessions, proj);
          if (!fs.statSync(projDir).isDirectory()) continue;
          const rawFiles = fs.readdirSync(projDir).filter((f) => f.endsWith(".md"));
          for (const rf of rawFiles) {
            const rContent = fs.readFileSync(path.join(projDir, rf), "utf-8");
            if (rContent.includes(`session_id: "${sessionId}"`)) {
              alreadyDone = true;
              break;
            }
          }
          if (alreadyDone) break;
        }
      } catch { /* non-fatal */ }
      if (alreadyDone) continue;

      const { userMessages, entries } = extractMessages(jsonlPath);
      if (entries < MIN_ENTRIES) continue;
      if (userMessages.length < 2) continue;

      // Determine project
      const dirName = dir.name.replace(/^--/, "").replace(/--$/, "").replace(/-/g, "/");
      const projName = TARGET_PROJECT; // for pi project, use "pi"
      const ts = sessionId.match(/T(\d{2}-\d{2}-\d{2})/)?.[1]?.replace(/-/g, ":") || "";

      missedSessions.push({
        filePath: jsonlPath,
        sessionId,
        timestamp: ts,
        project: projName,
        entries,
        userMessages,
        userMessageCount: userMessages.length,
      });
    }
  }

  if (missedSessions.length === 0) {
    console.log("✅ No missed sessions found.");
    return;
  }

  console.log(`Found ${missedSessions.length} missed sessions to force-ingest:\n`);
  for (const s of missedSessions) {
    const topic = s.userMessages[0].substring(0, 60);
    console.log(`  📄 [${s.timestamp}] ${s.entries} entries, ${s.userMessageCount} msgs → ${topic}`);
  }

  // Ingest each
  let ingested = 0;
  let errors = 0;

  for (const s of missedSessions) {
    const topic = s.userMessages[0].substring(0, 60).trim();
    const content = buildTier2Summary(s.userMessages);
    const result = writeRawFile(s.project, s.sessionId, topic, content);

    if (result) {
      console.log(`  ✅ ${result} (score: ${scoreContent(content)})`);
      ingested++;
    } else {
      errors++;
    }
  }

  console.log(`\n📊 Results: ${ingested} ingested, ${errors} errors`);

  if (ingested > 0) {
    console.log(`\n📢 Now run: cd ~/projects/pi-llm-wiki && npm run pipeline`);
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
