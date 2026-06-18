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
import { updateFrontmatter, markWeaved, markLinted } from "../manifest";
import { collectWikiPages } from "./analyzer";
import { compile as compileSession } from "../tools/compile";
import { readChangeLog, getCachedFiles, updateCache, needsFullScan, isRelevantPendingPath, logChange } from "./changes";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { scoreContent } from "../tools/ingest";
import { dlog } from "./log";
import { assessAllQuality } from "../tools/quality";
import { rebuildAllIndexes, rebuildRootIndex } from "./rebuild-indexes";

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

    // Rotate if > 500 lines (archive first 80%)
    try {
      const existing = fs.readFileSync(fullPath, "utf-8");
      const lines = existing.split("\n");
      if (lines.length > 500) {
        // Archive old entries to log-archive-YYYY-MM-DD.md
        const archiveDate = new Date().toISOString().split("T")[0];
        const archivePath = path.join(VAULT, `log-archive-${archiveDate}.md`);
        const keepLines = lines.slice(0, 100); // keep first 100 (header + old overview)
        const archiveLines = lines.slice(100, -100); // archive the middle
        if (archiveLines.length > 0) {
          fs.writeFileSync(
            archivePath,
            `# log.md 归档 — ${archiveDate}\n\n> 原始 log.md 超过 500 行，中间部分移至此处\n\n` +
            archiveLines.join("\n") + "\n",
            "utf-8"
          );
        }
        // Rewrite log.md with kept + recent lines
        const recentLines = lines.slice(-100);
        fs.writeFileSync(fullPath, [...keepLines, "", `## [${date}] log.md 已归档 (${archiveLines.length} 行)`].join("\n") + "\n", "utf-8");
      }
    } catch { /* 归档非致命 — 当前 log 继续追加 */ }

    fs.appendFileSync(fullPath, `## [${date}] ${prefix} | ${message}\n`);
  } catch { /* non-fatal */ }
}

// ── Auto-detect: scan for pending sessions (Phase 3: incremental) ──

/** Legacy full scan — reads every file to find pending sessions */
function fullScanPending(): string[] {
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
        // Phase 5: check unified status field first, fall back to old boolean
        const status = String(fm.status ?? "");
        const isCompiled = status === "compiled" || status === "woven" || status === "done" || status === "skipped"
          || String(fm.compiled) === "true";
        if (!isCompiled) {
          pending.push(`raw/sessions/${proj}/${f}`);
        }
      }
    }
  } catch { /* empty */ }
  return pending;
}

/** Incremental scan — only checks files in the change log */
function incrementalScanPending(): string[] {
  const cl = readChangeLog();
  const pending = new Set<string>();

  for (const change of cl.changes) {
    if (change.type === "ingest" && change.action === "create") {
      if (!isRelevantPendingPath(change.path)) continue;
      // Quick check: is it still pending?
      const fullPath = path.join(VAULT, change.path);
      try {
        if (!fs.existsSync(fullPath)) continue;
        const content = fs.readFileSync(fullPath, "utf-8");
        const fm = parseFrontmatter(content);
        // Phase 5: check unified status field first, fall back to old boolean
        const status = String(fm.status ?? "");
        const isCompiled = status === "compiled" || status === "woven" || status === "done" || status === "skipped"
          || String(fm.compiled) === "true";
        if (!isCompiled) {
          pending.add(change.path);
        }
      } catch { /* skip unreadable */ }
    }
  }

  return [...pending];
}

function scanPendingSessions(): string[] {
  // Use incremental scan if cache is fresh, fall back to full scan
  if (needsFullScan()) {
    const pending = fullScanPending();
    // Rebuild cache
    const allRaw: string[] = [];
    const allWiki: string[] = [];
    const base = path.join(VAULT, "raw/sessions");
    try {
      for (const proj of fs.readdirSync(base)) {
        const projDir = path.join(base, proj);
        if (!fs.statSync(projDir).isDirectory()) continue;
        for (const f of fs.readdirSync(projDir)) {
          if (f.endsWith(".md")) allRaw.push(`raw/sessions/${proj}/${f}`);
        }
      }
      const wikiBase = path.join(VAULT, "wiki");
      function walk(d: string) {
        for (const e of fs.readdirSync(d)) {
          const full = path.join(d, e);
          if (fs.statSync(full).isDirectory()) walk(full);
          else if (e.endsWith(".md")) allWiki.push(path.relative(VAULT, full));
        }
      }
      walk(wikiBase);
    } catch { /* skip */ }
    updateCache(allRaw, allWiki);
    return pending;
  }

  return incrementalScanPending();
}

/** Batch limit per pipeline run: avoids blocking session start for too long.
 *  Remaining sessions are picked up on the next before_agent_start hook. */
const BATCH_SIZE = 15;

// ── Auto-compile (Phase 2: delegates to compile.ts) ──

async function autoCompile(): Promise<{ wikiPaths: string[]; rawPaths: string[] }> {
  const pending = scanPendingSessions();
  if (pending.length < COMPILE_THRESHOLD) return { wikiPaths: [], rawPaths: [] };

  const batch = pending.slice(0, BATCH_SIZE);
  const remaining = pending.length - batch.length;

  const newWikiPaths: string[] = [];
  const compiledRawPaths: string[] = [];
  const ctx = { cwd: process.cwd() } as ExtensionContext;

  for (const rawPath of batch) {
    try {
      // Phase 4: Skip trivial sessions (score < 30 or marked trivial)
      const rawFullPath = path.join(VAULT, rawPath);
      if (fs.existsSync(rawFullPath)) {
        const rawContent = fs.readFileSync(rawFullPath, "utf-8");
        const rawFm = parseFrontmatter(rawContent);
        if (rawFm.trivial === true || rawFm.trivial === "true" || rawFm.skipped === "trivial") {
          // Phase 5: Mark as compiled+skipped to avoid re-scanning, using frontmatter update
          const updated = updateFrontmatter(rawContent, { compiled: true, status: "skipped" });
          fs.writeFileSync(rawFullPath, updated, "utf-8");
          appendLog("compile", `${rawPath} → (跳过，trivial session)`);
          continue;
        }
      }

      // Delegate to compile.ts — it handles dedup, insight extraction,
      // knowledge upgrade detection, and marks raw as compiled
      const result = await compileSession(rawPath, {}, ctx);

      if (result?.dedupSuggestion) {
        // Similar page exists; compile.ts already marked raw as compiled
        appendLog("compile", `${rawPath} → (跳过，${result.dedupSuggestion.slice(0, 80)})`);
        continue;
      }

      if (result?.wikiPath) {
        newWikiPaths.push(result.wikiPath);
        compiledRawPaths.push(rawPath);
        appendLog("compile", `${rawPath} → ${result.wikiPath}`);
      }
    } catch (e: any) {
      dlog(`auto-compile error for ${rawPath}: ${e.message}`);
    }
  }

  if (remaining > 0) {
    dlog(`⏸️ ${remaining} more sessions pending — will compile on next session start`);
  }

  // Also mark any pending sessions that are in the "fork-merged" or "trivial"
  // state — they were marked compiled in Phase 0 but may still appear pending
  // if the frontmatter format doesn't match compile.ts expectations.
  // This re-check is harmless and covers edge cases from Phase 0.
  for (const rawPath of pending) {
    try {
      const fullPath = path.join(VAULT, rawPath);
      if (fs.existsSync(fullPath)) {
        const content = fs.readFileSync(fullPath, "utf-8");
        const fm = parseFrontmatter(content);
        // Skip sessions already marked as compiled, fork-merged, or trivial
        if (fm.skipped === "fork-merged" || fm.skipped === "trivial") {
          const skipStatus = fm.skipped === "trivial" ? "skipped" : "compiled";
          if (String(fm.compiled) !== "true" || String(fm.status ?? "") !== skipStatus) {
            // Phase 5: Ensure both old boolean and new status field are set
            const updated = updateFrontmatter(content, { compiled: true, status: skipStatus });
            fs.writeFileSync(fullPath, updated, "utf-8");
          }
        }
      }
    } catch { /* skip */ }
  }

  return { wikiPaths: newWikiPaths, rawPaths: compiledRawPaths };
}

// ── Auto-weave: append backlinks to pages referenced by new wiki pages ──

function autoWeave(newWikiPaths: string[]): string[] {
  if (newWikiPaths.length === 0) return [];
  const now = new Date().toISOString().split("T")[0];
  const wovenPaths: string[] = [];

  for (const wikiPath of newWikiPaths) {
    let pageHadLink = false;
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
          const updatedTarget = targetContent.replace(
            logSection,
            `${logSection}\n${logEntry}`
          );
          fs.writeFileSync(targetFull, updatedTarget, "utf-8");
        } else if (!targetContent.includes(logEntry)) {
          fs.writeFileSync(
            targetFull,
            targetContent.trimEnd() + `\n\n${logSection}\n${logEntry}\n`,
            "utf-8"
          );
        }
        pageHadLink = true;
      }
      if (pageHadLink) wovenPaths.push(wikiPath);
    } catch (e: any) {
      dlog(`auto-weave error for ${wikiPath}: ${e.message}`);
    }
  }

  if (wovenPaths.length > 0) {
    appendLog("weave", `${wovenPaths.length}/${newWikiPaths.length} pages woven`);
  }
  return wovenPaths;
}

// ── ZInBox auto-compile (Phase 5: + score gate + incremental + insight extraction) ──

const ZINBOX_LAST_SCAN = path.join(process.env.HOME ?? "/home", ".pi/agent/zinbox-last-scan.json");

function readZinboxLastScan(): number {
  try { return JSON.parse(fs.readFileSync(ZINBOX_LAST_SCAN, "utf-8")).timestamp ?? 0; } catch { return 0; }
}

function writeZinboxLastScan(): void {
  try {
    fs.mkdirSync(path.dirname(ZINBOX_LAST_SCAN), { recursive: true });
    fs.writeFileSync(ZINBOX_LAST_SCAN, JSON.stringify({ timestamp: Date.now() }));
  } catch { /* non-fatal */ }
}

function autoCompileZinbox(): string[] {
  const zinboxDir = LLM_WIKI.zinbox;
  const indexDir = LLM_WIKI.zinboxIndex;
  fs.mkdirSync(indexDir, { recursive: true });

  // Phase 5: Incremental scan — only process files modified since last scan
  const lastScanTs = readZinboxLastScan();
  const now = new Date().toISOString().split("T")[0];

  // Scan ZInBox for .md files (filter by mtime if we have a previous scan)
  const allZinboxFiles: string[] = [];
  try {
    for (const entry of fs.readdirSync(zinboxDir)) {
      const full = path.join(zinboxDir, entry);
      if (entry.startsWith(".")) continue;
      if (entry === "00 Index.md" || entry === "00-Index.md") continue;
      if (fs.statSync(full).isDirectory()) {
        for (const sub of fs.readdirSync(full)) {
          if (sub.endsWith(".md")) {
            const subFull = path.join(full, sub);
            if (lastScanTs > 0 && fs.statSync(subFull).mtimeMs < lastScanTs) continue;
            allZinboxFiles.push(subFull);
          }
        }
      } else if (entry.endsWith(".md")) {
        if (lastScanTs > 0 && fs.statSync(full).mtimeMs < lastScanTs) continue;
        allZinboxFiles.push(full);
      }
    }
  } catch { return []; }

  // If no new files and we have a previous scan, skip entirely
  if (allZinboxFiles.length === 0 && lastScanTs > 0) {
    // 24h full-scan fallback — reset if scan data is old
    const scanAge = Date.now() - lastScanTs;
    if (scanAge > 24 * 60 * 60 * 1000) {
      writeZinboxLastScan(); // reset timestamp so next run rescans
    }
    return [];
  }

  // Find uncompiled files
  const existingIndexes = new Set(fs.readdirSync(indexDir));
  const allWikiPages = collectWikiPages();
  const existingPaths = new Set(allWikiPages.map((p) => p.path.replace(/\.md$/, "")));
  const existingTitles = new Set(allWikiPages.map((p) => p.title));
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

      // Phase 5: Score gate — skip trivial ZInBox content
      const zbScore = scoreContent(body);
      if (zbScore.isTrivial) {
        dlog(`ZInBox skip (trivial, score=${zbScore.score}): ${rel}`);
        fs.writeFileSync(
          path.join(indexDir, markerName),
          `---\nsource: "zinbox://${rel}"\ncompiled: true\nskipped: trivial\nscore: ${zbScore.score}\n---\n`,
          "utf-8"
        );
        existingIndexes.add(markerName);
        continue;
      }

      // ZInBox pages are external clippings — always route to 引用
      const wikiDir = "引用";

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

      // Don't copy ZInBox content into wiki — just create a marker for search tracking
      // ZInBox is searchable via obs-query scope=zinbox (grep on the ZInBox vault directly)
      fs.writeFileSync(
        path.join(indexDir, markerName),
        `---\nsource: "zinbox://${rel}"\ncompiled: true\nscore: ${zbScore.score}\n---\n`,
        "utf-8"
      );
      existingIndexes.add(markerName);
      compiled++;

      // Phase 5: Log to change log for incremental processing
      logChange({ type: "compile", path: `zinbox://${rel}`, action: "update" as const, timestamp: now });
    } catch (e: any) {
      // Skip unreadable files silently
    }
  }

  if (compiled > 0) {
    appendLog("compile", `ZInBox: ${compiled} clippings compiled to wiki`);
  }
  // Phase 5: Record last scan timestamp only if no batch limit was hit
  // If more files remain, don't advance — they'll be picked up next run
  if (compiled < BATCH_LIMIT || allZinboxFiles.length <= BATCH_LIMIT) {
    writeZinboxLastScan();
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

    // Quality assessment (Layer 4): score all pages + log summary
    const quality = assessAllQuality();
    const qSum =
      `✅≥4 ${quality.healthy} / 🟡=3 ${quality.fair} / ⚠️<3 ${quality.low}` +
      (quality.stale > 0 ? ` / 🗄️失活 ${quality.stale}` : "");
    appendLog("quality", `得分: ${qSum}`);
    dlog(`📊 Quality: ${quality.total} pages — ${qSum}`);
  } catch (e: any) {
    dlog(`auto-lint error: ${e.message}`);
  }
}

// ── Exported: batch-compile pending sessions (no threshold, used by agent-end on exit) ──

export async function batchCompilePending(ctx?: ExtensionContext): Promise<void> {
  const pending = scanPendingSessions();
  if (pending.length === 0) return;
  const c = ctx ?? ({ cwd: process.cwd() } as ExtensionContext);
  for (const rawPath of pending.slice(0, BATCH_SIZE)) {
    try {
      const fullPath = path.join(VAULT, rawPath);
      if (fs.existsSync(fullPath)) {
        const rawContent = fs.readFileSync(fullPath, "utf-8");
        const rawFm = parseFrontmatter(rawContent);
        if (rawFm.trivial === true || rawFm.trivial === "true" || rawFm.skipped === "trivial") {
          const updated = updateFrontmatter(rawContent, { compiled: true, status: "skipped" });
          fs.writeFileSync(fullPath, updated, "utf-8");
          continue;
        }
      }
      const result = await compileSession(rawPath, {}, c);
      if (result?.wikiPath) {
        dlog("batch-cleanup: " + rawPath + " → " + result.wikiPath);
      }
    } catch (e: any) { dlog("batch-cleanup error for " + rawPath + ": " + (e?.message ?? e)); }
  }
}

// ── Hook registration ──

export function refreshSystemPages(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async () => {
    try {
      // Backlog visibility: show pending count before pipeline
      const pendingCount = scanPendingSessions().length;
      if (pendingCount >= COMPILE_THRESHOLD) {
        const compileBatch = Math.min(pendingCount, BATCH_SIZE);
        const extra = pendingCount - compileBatch;
        const suffix = extra > 0 ? ` (+ ${extra} left for next run)` : "";
        dlog(`📦 Pipeline: ${pendingCount} pending — compiling ${compileBatch}${suffix}`);
      } else if (pendingCount > 0) {
        dlog(`📦 Backlog: ${pendingCount} sessions pending (need ${COMPILE_THRESHOLD} to trigger batch compile)`);
      }

      // Step 1: Auto-compile (if enough pending raw sessions)
      const { wikiPaths, rawPaths } = await autoCompile();
      let newPages = [...wikiPaths];

      // Step 1b: ZInBox auto-compile (external clippings, no copy to raw/)
      const zinboxPages = autoCompileZinbox();
      if (zinboxPages.length > 0) {
        dlog(`ZInBox compile: ${zinboxPages.length} clippings`);
        newPages = [...newPages, ...zinboxPages];
      }

      if (newPages.length > 0) {
        dlog(`🔄 Compiled ${newPages.length} new wiki pages`);

        // Step 2: Auto-weave backlinks
        const wovenPaths = autoWeave(newPages);
        const wovenSet = new Set(wovenPaths);
        dlog(`Auto-weave: ${wovenPaths.length}/${newPages.length} pages woven`);

        // Phase 5: Advance pipeline state — only mark sessions as woven + linted
        // if their wiki pages were successfully processed. Failed weaves will be
        // retried on the next pipeline run (sessions stay pending).
        let advancedCount = 0;
        for (let i = 0; i < rawPaths.length; i++) {
          // wikiPaths[i] corresponds to rawPaths[i] (parallel arrays from autoCompile)
          if (i < wikiPaths.length && wovenSet.has(wikiPaths[i])) {
            try {
              await markWeaved(rawPaths[i]);
              await markLinted(rawPaths[i]);
              advancedCount++;
            } catch { /* non-fatal per-session */ }
          }
        }
        if (advancedCount > 0) {
          dlog(`Pipeline: ${advancedCount}/${rawPaths.length} sessions advanced to done`);
        }
        dlog(`✅ Pipeline: compiled ${newPages.length}, woven ${wovenPaths.length}/${newPages.length}`);
      }

      // Step 3: Auto-lint (always, to keep log.md up-to-date)
      runAutoLint();

      // Step 3b: Rebuild index.md files (parallel async, ~200ms → ~50ms)
      await Promise.all([rebuildAllIndexes(), rebuildRootIndex()]);

      // Step 4: Regenerate status page
      writeSystemPage("wiki/状态.md", generateStatus());
    } catch (e: any) {
      dlog(`Hook error: ${e.message}`);
    }
  });
}
