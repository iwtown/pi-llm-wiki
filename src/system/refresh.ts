/**
 * pi-llm-wiki — System page refresh + auto-pipeline hook.
 * On before_agent_start:
 *   1. Regenerate unified status page (wiki/状态.md)
 *   2. Auto-compile if raw ≥ COMPILE_THRESHOLD
 *   3. Auto-weave + auto-lint after compile
 * Writes directly to vault filesystem (API-independent).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { LLM_WIKI, PATHS, COMPILE_THRESHOLD } from "../config";
import { generateStatus } from "./status";
import { parseFrontmatter } from "./parse";
import { collectWikiPages } from "./analyzer";

const VAULT = LLM_WIKI.vault;
const SCHEMA_PATH = path.join(VAULT, "schema.md");
const SCHEMA_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
let schemaCache: { content: string; timestamp: number } | null = null;

function writeSystemPage(relPath: string, content: string): void {
  const fullPath = path.join(VAULT, relPath);
  const dir = path.dirname(fullPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fullPath, content, "utf-8");
}

/**
 * Scan raw sessions for pending (compiled: false).
 * Returns list of raw paths relative to vault root.
 */
function scanPendingSessions(): string[] {
  const base = path.join(VAULT, "raw/sessions");
  const pending: string[] = [];
  try {
    for (const proj of fs.readdirSync(base)) {
      const projDir = path.join(base, proj);
      if (!fs.statSync(projDir).isDirectory()) continue;
      for (const f of fs.readdirSync(projDir)) {
        if (!f.endsWith(".md")) continue;
        const full = path.join(projDir, f);
        const content = fs.readFileSync(full, "utf-8");
        const fm = parseFrontmatter(content);
        if (String(fm.compiled) !== "true") {
          pending.push(`raw/sessions/${proj}/${f}`);
        }
      }
    }
  } catch { /* empty */ }
  return pending;
}

/**
 * Auto-compile: for each pending session, build a wiki page using simple
 * file-based logic (no REST API, no ExtensionContext needed).
 * This runs in before_agent_start so no Agent tools are available —
 * we do direct vault filesystem writes.
 */
function autoCompile(): number {
  const pending = scanPendingSessions();
  if (pending.length < COMPILE_THRESHOLD) return 0;

  let compiled = 0;
  const now = new Date().toISOString().split("T")[0];
  const allWikiPages = collectWikiPages();
  const existingPaths = new Set(allWikiPages.map((p) => p.path.replace(/\.md$/, "")));
  const existingTitles = new Set(allWikiPages.map((p) => p.title));

  for (const rawPath of pending) {
    try {
      const fullPath = path.join(VAULT, rawPath);
      const content = fs.readFileSync(fullPath, "utf-8");
      const fm = parseFrontmatter(content);

      // Skip if already compiled (double-check)
      if (String(fm.compiled) === "true") continue;

      // Extract title, project, body
      const title = String(fm.title ?? "").trim() || path.basename(rawPath, ".md");
      const project = String(fm.project ?? "unknown").trim();

      // Extract body (content after frontmatter)
      const bodyMatch = content.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
      const body = bodyMatch ? bodyMatch[1].trim() : "";

      // Determine wiki category: if body mentions key patterns
      const insightTypes: string[] = [];
      if (/决策|决定|选择/.test(body)) insightTypes.push("决策");
      if (/发现|陷阱|注意|教训/.test(body)) insightTypes.push("发现");
      if (/概念|理解|本质/.test(body)) insightTypes.push("概念");
      if (/步骤|流程|方法|如何/.test(body)) insightTypes.push("流程");
      if (/命令|CLI|命令行|快捷/.test(body)) insightTypes.push("命令");
      // Determine target dir
      const wikiDir = project !== "unknown" && insightTypes.length === 0
        ? `项目/${project}`
        : (insightTypes[0] ?? "发现");
      const wikiRelDir = wikiDir.startsWith("项目/") ? wikiDir : wikiDir;
      const wikiFileName = title.replace(/[/\\?%*:|"<>]/g, "-").replace(/\s+/g, "-").slice(0, 80) || "untitled";
      const wikiRelPath = wikiDir.startsWith("项目/")
        ? `wiki/项目/${project}/${wikiFileName}.md`
        : `wiki/${wikiDir}/${wikiFileName}.md`;

      // Avoid re-compiling existing topics
      const wikiMatch = existingPaths.has(wikiRelPath.replace(/\.md$/, "")) || existingTitles.has(title);
      if (wikiMatch) {
        // Don't create duplicate — mark compiled and linked
        const fmUpdated = content.replace(/^compiled:\s*.*$/m, "compiled: true")
          .replace(/compiled:\s*false/, "compiled: true")
          .replace(/^---\n([\s\S]*?)\n---/, (match, fmStr: string) => {
            if (!/^compiled:/m.test(fmStr)) {
              return match.replace(/^---\n/, `---\ncompiled: true\n`);
            }
            return match;
          });
        fs.writeFileSync(fullPath, fmUpdated, "utf-8");
        compiled++;
        continue;
      }

      // Build wiki page
      const tagDir = wikiDir.startsWith("项目/") ? "项目" : wikiDir;
      const wikiContent = `---
title: "${title}"
tags: [wiki/${tagDir}, compiled]
type: "${tagDir}"
project: "${project}"
source: "${rawPath}"
created: ${now}
compiled: ${now}
related: []
---

# ${title}

${body}

> 自动编译自 [[${rawPath}]]
`;

      const wikiFullPath = path.join(VAULT, wikiRelPath);
      fs.mkdirSync(path.dirname(wikiFullPath), { recursive: true });
      fs.writeFileSync(wikiFullPath, wikiContent, "utf-8");

      // Mark raw as compiled
      const fmUpdated = content.includes("compiled: false")
        ? content.replace("compiled: false", "compiled: true")
        : content.includes("---\n") && !/^compiled:/m.test(content.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "")
          ? content.replace(/^---\n/, "---\ncompiled: true\n")
          : content;
      fs.writeFileSync(fullPath, fmUpdated, "utf-8");

      // Update log.md
      const logLine = `## [${now}] compile | ${rawPath} → ${wikiRelPath}\n`;
      const logFullPath = path.join(VAULT, "log.md");
      try { fs.appendFileSync(logFullPath, logLine); } catch { /* skip */ }

      compiled++;
    } catch (e: any) {
      console.error(`[pi-llm-wiki] auto-compile error for ${rawPath}: ${e.message}`);
    }
  }

  return compiled;
}

/** Record query and lint events in log.md */
function appendLog(prefix: string, message: string): void {
  try {
    const date = new Date().toISOString().split("T")[0];
    const logFullPath = path.join(VAULT, "log.md");
    fs.appendFileSync(logFullPath, `## [${date}] ${prefix} | ${message}\n`);
  } catch { /* non-fatal */ }
}

export function refreshSystemPages(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (_event, _ctx) => {
    try {
      // Step 1: Auto-compile if threshold met
      const compiled = autoCompile();
      if (compiled > 0) {
        console.error(`[pi-llm-wiki] Auto-compiled ${compiled} sessions`);
      }

      // Step 2: Regenerate status page
      writeSystemPage("wiki/状态.md", generateStatus());
      console.error("[pi-llm-wiki] Status page refreshed");
    } catch (e: any) {
      console.error(`[pi-llm-wiki] Failed to refresh system pages: ${e.message}`);
    }
  });
}
