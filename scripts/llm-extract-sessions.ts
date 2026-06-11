/**
 * Batch extract structured summaries from pending recovery sessions using LLM.
 *
 * For each pending recovery session:
 *   1. Find original .jsonl by session_id
 *   2. Extract user messages
 *   3. Call DeepSeek API to extract 🎯/⚖️/💡/⚠️
 *   4. Rewrite vault raw session with structured content
 *
 * Usage: LLM_EXTRACT_KEY=$DEEPSEEK_API_KEY npx tsx scripts/llm-extract-sessions.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";

const VAULT = "/mnt/d/DB/Obsidian/LLM-Wiki";
const SESSIONS_BASE = path.join(process.env.HOME!, ".pi/agent/sessions");

interface SessionEntry {
  type: string;
  message?: { role?: string; content?: any };
}

function readSessionMessages(jsonlPath: string): string[] {
  const msgs: string[] = [];
  try {
    const raw = fs.readFileSync(jsonlPath, "utf-8");
    for (const line of raw.split("\n").filter(Boolean)) {
      try {
        const e: SessionEntry = JSON.parse(line);
        let text = "";
        if (e.type === "message" && e.message?.role === "user") {
          const content = e.message.content;
          if (Array.isArray(content)) {
            text = content.map((b: any) => b.text || "").join(" ");
          } else if (typeof content === "string") {
            text = content;
          }
        } else if (e.type === "user") {
          const msg = e.message || e;
          if (typeof msg === "string") text = msg;
          else if (typeof msg === "object") {
            const c = (msg as any).content;
            if (Array.isArray(c)) text = c.map((b: any) => b.text || "").join(" ");
            else if (typeof c === "string") text = c;
          }
        }
        if (text.trim()) msgs.push(text.trim());
      } catch { /* skip malformed JSON */ }
    }
  } catch { /* skip unreadable */ }
  return msgs;
}

async function callLLM(messages: string[]): Promise<string | null> {
  const apiKey = process.env.LLM_EXTRACT_KEY || process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return null;

  // Build prompt from user messages
  const conversation = messages.join("\n---\n");
  const prompt = `You are an AI assistant extracting structured knowledge from a conversation between a user and an AI coding agent.

Extract these sections from the conversation. Be concise and specific.

### 🎯 目标
What was the user's goal? 1-2 sentences.

### ⚖️ 决策
Key decisions made (technical choices, tool selections, architecture decisions). List each as "- decision".

### 💡 洞察
Notable discoveries, traps encountered, or lessons learned. List each as "- insight".

### ⚠️ 遗留
Open issues or things left unfinished. List each as "- issue".

If any section has nothing to report, write "暂无" instead of omitting it.

Conversation:
${conversation.slice(0, 6000)}`;

  try {
    const res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 1000,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      console.error(`  API error: ${res.status} ${res.statusText}`);
      return null;
    }

    const data = await res.json() as any;
    return data.choices?.[0]?.message?.content || null;
  } catch (e: any) {
    console.error(`  API call failed: ${e.message}`);
    return null;
  }
}

function findJsonlBySessionId(sessionId: string): string | null {
  for (const projDir of fs.readdirSync(SESSIONS_BASE)) {
    const full = path.join(SESSIONS_BASE, projDir);
    if (!fs.statSync(full).isDirectory()) continue;
    const fp = path.join(full, `${sessionId}.jsonl`);
    if (fs.existsSync(fp)) return fp;
  }
  return null;
}

async function main() {
  // Find all pending recovery sessions
  const pending: Array<{ file: string; sessionId: string; jsonlPath: string | null }> = [];

  for (const projDir of fs.readdirSync(path.join(VAULT, "raw/sessions"))) {
    const full = path.join(VAULT, "raw/sessions", projDir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const f of fs.readdirSync(full)) {
      if (!f.endsWith(".md")) continue;
      if (!f.includes("recovery")) continue;
      const content = fs.readFileSync(path.join(full, f), "utf-8");
      if (content.includes("status: pending")) {
        const sidMatch = content.match(/session_id:\s*"([^"]+)"/);
        const sessionId = sidMatch?.[1] || "";
        const jsonlPath = sessionId ? findJsonlBySessionId(sessionId) : null;
        pending.push({ file: path.join(full, f), sessionId, jsonlPath });
      }
    }
  }

  console.log(`Found ${pending.length} pending recovery sessions\n`);

  let extracted = 0;
  let skipped = 0;
  let failed = 0;

  for (const p of pending) {
    const name = path.basename(p.file);
    console.log(`[${extracted + skipped + failed + 1}/${pending.length}] ${name}...`);

    if (!p.jsonlPath) {
      console.log(`  ⏭️  No .jsonl found for session_id=${p.sessionId.slice(0, 20)}...`);
      skipped++;
      continue;
    }

    const msgs = readSessionMessages(p.jsonlPath);
    if (msgs.length < 2) {
      console.log(`  ⏭️  Only ${msgs.length} messages, skipping`);
      skipped++;
      continue;
    }

    // Truncate messages to fit context (last 20 meaningful messages)
    const contextMsgs = msgs.slice(-20);
    console.log(`  ${msgs.length} total msgs, using last ${contextMsgs.length}`);

    const llmOutput = await callLLM(contextMsgs);
    if (!llmOutput) {
      console.log(`  ❌ LLM extraction failed`);
      failed++;
      continue;
    }

    // Build new content with LLM extraction
    const firstLine = contextMsgs[0].slice(0, 60).replace(/"/g, "'").replace(/\n/g, " ");
    const date = path.basename(p.file).slice(0, 10);
    const projMatch = p.file.match(/raw\/sessions\/([^/]+)/);
    const projName = projMatch?.[1] || "unknown";

    const newContent = `---
title: "${firstLine}"
project: "${projName}"
date: ${date}
session_id: "${p.sessionId}"
session_score: 85
trivial: false
compiled: false
status: pending
status_v2: "pending"
tags: [session, ${projName}, llm-extracted]
---

## 会话复盘 — ${date}

> 📝 LLM 提取 — 从原始 session 消息结构化

${llmOutput}
`;

    fs.writeFileSync(p.file, newContent, "utf-8");
    extracted++;
    console.log(`  ✅ Extracted (${llmOutput.length} chars)`);
  }

  console.log(`\n=== Done ===`);
  console.log(`Extracted: ${extracted}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total: ${pending.length}`);
}

main().catch(console.error);
