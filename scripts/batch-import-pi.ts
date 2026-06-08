/**
 * Batch import pi project sessions into vault raw/sessions/pi/
 * 
 * Reads all .jsonl session files from ~/.pi/agent/sessions/--home-wtown-projects-pi--/
 * and creates raw session markdown files in vault/raw/sessions/pi/
 * 
 * Usage: npx tsx scripts/batch-import-pi.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";

const SESSIONS_DIR = path.resolve(process.env.HOME || "/home", ".pi/agent/sessions/--home-wtown-projects-pi--");
const VAULT = "/mnt/d/DB/Obsidian/LLM-Wiki";

// ── Helpers ──

function extractUserMessages(lines: any[]): string[] {
  const messages: string[] = [];
  for (const line of lines) {
    if (!line || line.type !== "message") continue;
    const msg = line.message;
    if (!msg || msg.role !== "user") continue;
    const content = msg.content;
    if (!content) continue;
    if (typeof content === "string") {
      messages.push(content);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block && (block.type === "text" || block.type === "input_text") && block.text) {
          messages.push(block.text);
        }
      }
    }
  }
  return messages;
}

function getSessionDate(lines: any[]): string {
  for (const line of lines) {
    if (!line) continue;
    if (line.type === "session" && line.timestamp) {
      return line.timestamp.split("T")[0];
    }
  }
  return new Date().toISOString().split("T")[0];
}

function sanitizeTitle(text: string, maxLen = 60): string {
  // Take first meaningful user message as title
  const cleaned = text
    .replace(/^["""'']+/, "")
    .replace(/["""'']+$/, "")
    .replace(/^[\s\S]*?\n/, "")  // remove first line if multi-line
    .trim()
    .slice(0, maxLen)
    .replace(/[<>:"/\\|?*]/g, "-")
    .trim();
  if (!cleaned) return "未命名对话";
  return cleaned;
}

function buildRawContent(lines: any[], userMessages: string[]): string | null {
  if (userMessages.length <= 1 && userMessages.reduce((s, m) => s + m.length, 0) < 200) {
    return null; // trivial
  }

  const date = getSessionDate(lines);
  const firstMsg = userMessages[0];
  const title = sanitizeTitle(firstMsg);
  const nickname = `批量导入-${date}`;

  // Extract decisions/insights from messages
  const decisions: string[] = [];
  const insights: string[] = [];
  const keywords = {
    decision: /决定|选择|采用|改成|用|切换|配置|安装|不[用要选]|弃用|改用|选用/i,
    insight: /发现|注意|注意:|陷阱|坑:|trap|注意:|bug:|问题:|必须|需要|理解|原因/i,
  };

  for (let i = 1; i < userMessages.length; i++) {
    const m = userMessages[i];
    const short = m.slice(0, 200).trim();
    if (keywords.decision.test(m)) decisions.push(`- ${short}`);
    if (keywords.insight.test(m)) insights.push(`- ${short}`);
  }

  const bodyParts: string[] = [];

  // Goal
  bodyParts.push(`### 🎯 目标`, "");
  bodyParts.push(firstMsg.length > 300 ? firstMsg.slice(0, 300) + "..." : firstMsg, "");

  // Activity
  const seen = new Set<string>();
  const activities: string[] = [];
  for (let i = userMessages.length - 1; i >= 0 && activities.length < 10; i--) {
    const short = userMessages[i].slice(0, 150);
    const key = short.toLowerCase().trim();
    if (!seen.has(key)) {
      seen.add(key);
      activities.unshift(`- ${userMessages[i].length > 150 ? short + "..." : short}`);
    }
  }
  bodyParts.push(`### 📋 会话活动 (${userMessages.length} 条用户消息)`, "");
  bodyParts.push(...activities, "");

  // Decisions
  if (decisions.length > 0) {
    bodyParts.push("### ⚖️ 决策", "");
    bodyParts.push(...decisions.slice(0, 5), "");
  }

  // Insights
  if (insights.length > 0) {
    bodyParts.push("### 💡 洞察", "");
    bodyParts.push(...insights.slice(0, 5), "");
  }

  bodyParts.push("### ⚠️ 遗留", "");
  bodyParts.push("批量导入 — 待审核。此 session 来自早期 pi 项目，由一次性的 batch-import 脚本导入。", "");

  const body = bodyParts.join("\n");

  return `---
title: "${title}"
tags: [session, pi]
created: ${date}
updated: ${date}
project: "pi"
session_id: "${nickname}"
status: raw
compiled: false
weaved: false
linted: false
---

# ${title}

> 🤖 批量导入 — 来自 ~/.pi/agent/sessions/--home-wtown-projects-pi--/

${body}
`;
}

// ── Main ──

async function main() {
  const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".jsonl"));
  console.log(`Found ${files.length} .jsonl files in ${SESSIONS_DIR}`);

  const outDir = path.join(VAULT, "raw/sessions/pi");
  fs.mkdirSync(outDir, { recursive: true });

  let imported = 0;
  let skipped = 0;
  let errors = 0;

  for (const file of files.sort()) {
    try {
      const fullPath = path.join(SESSIONS_DIR, file);
      const content = fs.readFileSync(fullPath, "utf-8");
      const lines = content
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        });

      const userMessages = extractUserMessages(lines);
      const rawContent = buildRawContent(lines, userMessages);

      if (!rawContent) {
        skipped++;
        continue;
      }

      const date = getSessionDate(lines);
      const firstMsg = sanitizeTitle(userMessages[0] || "");
      // Avoid filename collisions: use session id from file
      const sessionId = file.replace(/\.jsonl$/, "").substring(20, 32);
      const safeName = `${date}-pi-batch-${sessionId}`.replace(/[<>:"/\\|?*]/g, "-");
      const outPath = path.join(outDir, `${safeName}.md`);

      // Check if already exists (deduplicate)
      if (fs.existsSync(outPath)) {
        skipped++;
        continue;
      }

      fs.writeFileSync(outPath, rawContent, "utf-8");
      imported++;
    } catch (e: any) {
      errors++;
      console.error(`Error processing ${file}: ${e.message}`);
    }

    // Progress indicator
    if ((imported + skipped + errors) % 20 === 0) {
      console.log(`Progress: ${imported} imported, ${skipped} skipped, ${errors} errors`);
    }
  }

  console.log(`\nDone: ${imported} imported, ${skipped} skipped, ${errors} errors`);
  console.log(`Output: ${outDir}/`);
}

main().catch(console.error);
