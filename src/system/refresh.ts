/**
 * pi-llm-wiki — System page refresh + auto-pipeline hook.
 * On before_agent_start:
 *   1. Auto-compile if raw ≥ COMPILE_THRESHOLD
 *   2. Auto-weave (append backlinks to related pages)
 *   3. Auto-lint (log health summary)
 *   4. Generate unified status page (wiki/状态.md)
 * Writes directly to vault filesystem (fs-first, API-independent).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { LLM_WIKI, COMPILE_THRESHOLD } from "../config";
import { generateStatus, autoLint } from "./status";
import { parseFrontmatter } from "./parse";
import { collectWikiPages } from "./analyzer";

const VAULT = LLM_WIKI.vault;

function writeSystemPage(relPath: string, content: string): void {
  const fullPath = path.join(VAULT, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf-8");
}

function appendLog(prefix: string, message: string): void {
  try {
    const date = new Date().toISOString().split("T")[0];
    const fullPath = path.join(VAULT, "log.md");
    fs.appendFileSync(fullPath, `## [${date}] ${prefix} | ${message}\n`);
  } catch { /* non-fatal */ }
}

// ── Auto-detect: scan for pending sessions ──

function scanPendingSessions(): string[] {
  const base = path.join(VAULT, "raw/sessions");
  const pending: string[] = [];
  try {
    for (const proj of fs.readdirSync(base)) {
      const projDir = path.join(base, proj);
      if (!fs.statSync(projDir).isDirectory()) continue;
      for (const f of fs.readdirSync(projDir)) {
        if (!f.endsWith(".md")) continue;
        const content = fs.readFileSync(path.join(projDir, f), "utf-8");
        const fm = parseFrontmatter(content);
        if (String(fm.compiled) !== "true") {
          pending.push(`raw/sessions/${proj}/${f}`);
        }
      }
    }
  } catch { /* empty */ }
  return pending;
}

// ── Auto-compile ──

function autoCompile(): string[] {
  const pending = scanPendingSessions();
  if (pending.length < COMPILE_THRESHOLD) return [];

  const now = new Date().toISOString().split("T")[0];
  const allWikiPages = collectWikiPages();
  const existingPaths = new Set(allWikiPages.map((p) => p.path.replace(/\.md$/, "")));
  const existingTitles = new Set(allWikiPages.map((p) => p.title));
  const newWikiPaths: string[] = [];

  for (const rawPath of pending) {
    try {
      const fullPath = path.join(VAULT, rawPath);
      const content = fs.readFileSync(fullPath, "utf-8");
      const fm = parseFrontmatter(content);
      if (String(fm.compiled) === "true") continue;

      const title = String(fm.title ?? "").trim() || path.basename(rawPath, ".md");
      const project = String(fm.project ?? "unknown").trim();
      const bodyMatch = content.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
      const body = bodyMatch ? bodyMatch[1].trim() : "";

      // Determine wiki category from body content
      const insightTypes: string[] = [];
      if (/决策|决定|选择/.test(body)) insightTypes.push("决策");
      if (/发现|陷阱|注意|教训/.test(body)) insightTypes.push("发现");
      if (/概念|理解|本质/.test(body)) insightTypes.push("概念");
      if (/步骤|流程|方法|如何/.test(body)) insightTypes.push("流程");
      if (/命令|CLI|命令行|快捷/.test(body)) insightTypes.push("命令");
      const wikiDir = project !== "unknown" && insightTypes.length === 0
        ? `项目/${project}`
        : (insightTypes[0] ?? "发现");
      const wikiFileName = title.replace(/[/\\?%*:|"<>]/g, "-").replace(/\s+/g, "-").slice(0, 80) || "untitled";
      const wikiRelPath = wikiDir.startsWith("项目/")
        ? `wiki/项目/${project}/${wikiFileName}.md`
        : `wiki/${wikiDir}/${wikiFileName}.md`;

      // Avoid re-creating existing topics
      if (existingPaths.has(wikiRelPath.replace(/\.md$/, "")) || existingTitles.has(title)) {
        // Just mark raw as compiled
        const updated = content.includes("compiled: false")
          ? content.replace("compiled: false", "compiled: true")
          : content;
        fs.writeFileSync(fullPath, updated, "utf-8");
        appendLog("compile", `${rawPath} → (跳过，已存在类似页面)`);
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
      newWikiPaths.push(wikiRelPath);

      // Mark raw as compiled
      const updated = content.includes("compiled: false")
        ? content.replace("compiled: false", "compiled: true")
        : content;
      fs.writeFileSync(fullPath, updated, "utf-8");

      appendLog("compile", `${rawPath} → ${wikiRelPath}`);
    } catch (e: any) {
      console.error(`[pi-llm-wiki] auto-compile error for ${rawPath}: ${e.message}`);
    }
  }

  return newWikiPaths;
}

// ── Auto-weave: append backlinks to pages referenced by new wiki pages ──

function autoWeave(newWikiPaths: string[]): number {
  if (newWikiPaths.length === 0) return 0;
  const now = new Date().toISOString().split("T")[0];
  let updated = 0;

  for (const wikiPath of newWikiPaths) {
    try {
      const fullPath = path.join(VAULT, wikiPath);
      const content = fs.readFileSync(fullPath, "utf-8");

      // Extract [[wikilinks]] from the new page
      const links = [...content.matchAll(/\[\[([^\]|#]+?)(?:[|#][^\]]+)?\]\]/g)]
        .map((m) => m[1].trim())
        .filter((l) => !l.startsWith("raw/"));

      for (const link of links) {
        // Resolve wikilink to a file path
        const candidates = [
          `${link}.md`,
          `wiki/${link}.md`,
          link.includes("/") ? link : `wiki/发现/${link}.md`,
        ];
        let targetPath = "";
        for (const c of candidates) {
          const abs = path.join(VAULT, c);
          if (fs.existsSync(abs)) { targetPath = c; break; }
        }
        if (!targetPath) continue;

        // Skip system pages
        if (targetPath.startsWith("wiki/状态.md") || targetPath.startsWith("wiki/图谱.md")) continue;

        // Append backlink entry
        const targetFull = path.join(VAULT, targetPath);
        const targetContent = fs.readFileSync(targetFull, "utf-8");
        const logEntry = `- [[${wikiPath.replace(/\.md$/, "")}]] auto-weave (${now})`;
        const logSection = "## 📋 经验日志";

        if (targetContent.includes(logSection)) {
          // Append to existing log section
          const updatedTarget = targetContent.replace(
            logSection,
            `${logSection}\n${logEntry}`
          );
          fs.writeFileSync(targetFull, updatedTarget, "utf-8");
        } else if (!targetContent.includes(logEntry)) {
          // Create log section at end
          fs.writeFileSync(
            targetFull,
            targetContent.trimEnd() + `\n\n${logSection}\n${logEntry}\n`,
            "utf-8"
          );
        }
        updated++;
      }
    } catch (e: any) {
      console.error(`[pi-llm-wiki] auto-weave error for ${wikiPath}: ${e.message}`);
    }
  }

  if (updated > 0) {
    appendLog("weave", `${updated} backlinks added across ${newWikiPaths.length} new pages`);
  }
  return updated;
}

// ── ZInBox auto-compile (compile clippings into wiki without copying to raw/) ──

function autoCompileZinbox(): string[] {
  const zinboxDir = LLM_WIKI.zinbox;
  const indexDir = LLM_WIKI.zinboxIndex;
  fs.mkdirSync(indexDir, { recursive: true });

  // Scan ZInBox for .md files
  const allZinboxFiles: string[] = [];
  try {
    for (const entry of fs.readdirSync(zinboxDir)) {
      const full = path.join(zinboxDir, entry);
      if (entry.startsWith(".")) continue;
      if (entry === "00 Index.md" || entry === "00-Index.md") continue;
      if (fs.statSync(full).isDirectory()) {
        for (const sub of fs.readdirSync(full)) {
          if (sub.endsWith(".md")) allZinboxFiles.push(path.join(full, sub));
        }
      } else if (entry.endsWith(".md")) {
        allZinboxFiles.push(full);
      }
    }
  } catch { return []; }

  // Find uncompiled files
  const existingIndexes = new Set(fs.readdirSync(indexDir));
  const now = new Date().toISOString().split("T")[0];
  const existingPaths = new Set(collectWikiPages().map((p) => p.path.replace(/\.md$/, "")));
  const existingTitles = new Set(collectWikiPages().map((p) => p.title));
  const newWikiPaths: string[] = [];
  let compiled = 0;

  // Limit per batch to avoid overwhelming
  const BATCH_LIMIT = 15;

  for (const zf of allZinboxFiles) {
    if (compiled >= BATCH_LIMIT) break;

    const rel = path.relative(zinboxDir, zf);
    // Marker filename = hash of relative path (use safe filename)
    const markerName = rel.replace(/[\\\/:*?"<>|]/g, "_").replace(/\.md$/, "") + ".md";

    if (existingIndexes.has(markerName)) continue; // already tracked

    try {
      const content = fs.readFileSync(zf, "utf-8");
      // Skip image-heavy or tiny files
      if (content.length < 200) continue;

      const fm = parseFrontmatter(content);
      const title = String(fm.title ?? "").trim() || rel.replace(/\.md$/, "").replace(/^.*[\\\/]/, "");

      // Check if already exists in wiki
      if (existingTitles.has(title)) {
        // Create marker anyway to avoid re-scan
        fs.writeFileSync(
          path.join(indexDir, markerName),
          `---\nsource: "zinbox://${rel}"\ncompiled: true\nskipped: duplicate\n---\n`,
          "utf-8"
        );
        existingIndexes.add(markerName);
        continue;
      }

      // Extract body (after frontmatter)
      const bodyMatch = content.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
      const body = (bodyMatch ? bodyMatch[1].trim() : content).slice(0, 3000);

      // Determine wiki type
      const typeHints: string[] = [];
      if (/决策|决定|选择|改用|配置/.test(body)) typeHints.push("决策");
      if (/发现|陷阱|注意|教训|坑/.test(body)) typeHints.push("发现");
      if (/概念|原理|本质|模型|理论/.test(body)) typeHints.push("概念");
      if (/步骤|流程|方法|如何|教程|指南/.test(body)) typeHints.push("流程");
      if (/命令|CLI|命令行|快捷|快捷键/.test(body)) typeHints.push("命令");
      const wikiDir = typeHints[0] || "发现";

      const fileName = title.replace(/[/\\?%*:"<>]/g, "-").replace(/\s+/g, "-").slice(0, 80) || "untitled";

      // Check path collision
      const wikiRelPath = `wiki/${wikiDir}/${fileName}.md`;
      if (existingPaths.has(wikiRelPath.replace(/\.md$/, ""))) {
        fs.writeFileSync(
          path.join(indexDir, markerName),
          `---\nsource: "zinbox://${rel}"\ncompiled: true\nskipped: path_collision\n---\n`,
          "utf-8"
        );
        existingIndexes.add(markerName);
        continue;
      }

      // Create wiki page
      const wikiContent = `---
title: "${title}"
tags: [wiki/${wikiDir}, compiled, zinbox]
type: "${wikiDir}"
source: "zinbox://${rel}"
created: ${now}
compiled: ${now}
related: []
---

# ${title}

${body}

> 来源: [[zinbox://${rel}]] — ZInBox 剪藏库
`;

      const wikiFullPath = path.join(VAULT, wikiRelPath);
      fs.mkdirSync(path.dirname(wikiFullPath), { recursive: true });
      fs.writeFileSync(wikiFullPath, wikiContent, "utf-8");
      newWikiPaths.push(wikiRelPath);

      // Create marker
      fs.writeFileSync(
        path.join(indexDir, markerName),
        `---\nsource: "zinbox://${rel}"\ncompiled: true\nwiki: "${wikiRelPath}"\n---\n`,
        "utf-8"
      );
      existingIndexes.add(markerName);
      compiled++;
    } catch (e: any) {
      // Skip unreadable files silently
    }
  }

  if (compiled > 0) {
    appendLog("compile", `ZInBox: ${compiled} clippings compiled to wiki`);
  }
  return newWikiPaths;
}

// ── Auto-lint ──

function runAutoLint(): void {
  try {
    const report = autoLint();
    if (report.errors + report.warnings > 0) {
      appendLog("lint", `⚠️ ${report.errors} errors, ${report.warnings} warnings (stale:${report.stale}, orphans:${report.orphans})`);
    } else {
      appendLog("lint", `✅ 健康 — ${report.total} pages`);
    }
  } catch (e: any) {
    console.error(`[pi-llm-wiki] auto-lint error: ${e.message}`);
  }
}

// ── Hook registration ──

export function refreshSystemPages(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async () => {
    try {
      // Step 1: Auto-compile (if enough pending raw sessions)
      const rawPages = autoCompile();
      let newPages = rawPages;

      // Step 1b: ZInBox auto-compile (external clippings, no copy to raw/)
      const zinboxPages = autoCompileZinbox();
      if (zinboxPages.length > 0) {
        console.error(`[pi-llm-wiki] ZInBox compile: ${zinboxPages.length} clippings`);
        newPages = [...newPages, ...zinboxPages];
      }

      if (newPages.length > 0) {
        console.error(`[pi-llm-wiki] Auto-compiled ${newPages.length} total`);

        // Step 2: Auto-weave backlinks
        const woven = autoWeave(newPages);
        console.error(`[pi-llm-wiki] Auto-weave: ${woven} backlinks`);
      }

      // Step 3: Auto-lint (always, to keep log.md up-to-date)
      runAutoLint();

      // Step 4: Regenerate status page
      writeSystemPage("wiki/状态.md", generateStatus());
      console.error("[pi-llm-wiki] Status page refreshed");
    } catch (e: any) {
      console.error(`[pi-llm-wiki] Hook error: ${e.message}`);
    }
  });
}
