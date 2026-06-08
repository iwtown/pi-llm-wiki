/**
 * pi-llm-wiki — Unified status page generator.
 * Replaces separate dashboard/audit/tracker with a single wiki/状态.md.
 * Reads vault filesystem directly (API-independent).
 * Ony prints details when something's wrong — green = nothing to see.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { LLM_WIKI, PATHS, ANALYSIS, STALE_DAYS } from "../config";
import { parseFrontmatter } from "./parse";

const VAULT = LLM_WIKI.vault;

interface RawFile {
  relPath: string;
  fm: Record<string, unknown>;
}

function readAllRaw(): RawFile[] {
  const base = path.join(VAULT, "raw/sessions");
  const files: RawFile[] = [];
  try {
    for (const proj of fs.readdirSync(base)) {
      const projDir = path.join(base, proj);
      if (!fs.statSync(projDir).isDirectory()) continue;
      for (const f of fs.readdirSync(projDir)) {
        if (!f.endsWith(".md")) continue;
        const full = path.join(projDir, f);
        const content = fs.readFileSync(full, "utf-8");
        files.push({ relPath: `raw/sessions/${proj}/${f}`, fm: parseFrontmatter(content) });
      }
    }
  } catch { /* empty vault */ }
  return files;
}

function collectWikiFiles(): Array<{ relPath: string; fm: Record<string, unknown>; content: string }> {
  const result: Array<{ relPath: string; fm: Record<string, unknown>; content: string }> = [];
  const wikiDir = path.join(VAULT, "wiki");
  function walk(dir: string) {
    try {
      for (const e of fs.readdirSync(dir)) {
        const full = path.join(dir, e);
        if (fs.statSync(full).isDirectory()) walk(full);
        else if (e.endsWith(".md")) {
          const content = fs.readFileSync(full, "utf-8");
          const rel = path.relative(VAULT, full);
          result.push({ relPath: rel, fm: parseFrontmatter(content), content });
        }
      }
    } catch { /* skip */ }
  }
  walk(wikiDir);
  return result;
}

export interface AgentEndStats {
  ok: number;
  fail: number;
  lastOk: string;
}

/** Read agent_end stats from structured log (best-effort) */
function readAgentEndStats(): AgentEndStats {
  const result: AgentEndStats = { ok: 0, fail: 0, lastOk: "" };
  try {
    const logPath = PATHS.structured;
    if (!fs.existsSync(logPath)) return result;
    const lines = fs.readFileSync(logPath, "utf-8").split("\n").filter(Boolean).slice(-50);
    for (const line of lines) {
      try {
        const ev = JSON.parse(line);
        if (ev.event === "auto_ingest_ok") { result.ok++; result.lastOk = ev.ts ?? ""; }
        if (ev.event === "auto_ingest_fail") result.fail++;
      } catch { /* skip malformed */ }
    }
  } catch { /* non-fatal */ }
  return result;
}

export function generateStatus(): string {
  const rawFiles = readAllRaw();
  const wikiFiles = collectWikiFiles();
  const now = new Date().toISOString().split("T")[0];
  const agentEnd = readAgentEndStats();

  // ── Compute pipeline stats ──
  const total = rawFiles.length;
  const compiled = rawFiles.filter((r) => String(r.fm.compiled) === "true").length;
  const weaved = rawFiles.filter((r) => String(r.fm.weaved) === "true").length;
  const linted = rawFiles.filter((r) => String(r.fm.linted) === "true").length;
  const pendingCompile = total - compiled;
  const pendingWeave = compiled - weaved;
  const pendingLint = weaved - linted;

  // ── Find orphans (pages with no inbound [[wikilinks]]) ──
  const skipOrphan = new Set([
    "wiki/图谱.md", "wiki/仪表盘.md", "wiki/流程巡检.md", "wiki/问题追踪.md", "wiki/hot.md", PATHS.index, PATHS.dashboard, PATHS.hot, PATHS.inspection, PATHS.issues
  ]);
  const incomingCount = new Map<string, number>();
  const wikiTitles = new Map<string, string>();
  for (const wf of wikiFiles) {
    const title = String(wf.fm.title ?? "");
    if (title) wikiTitles.set(title, wf.relPath);
    const links = [...wf.content.matchAll(/\[\[([^\]|#]+?)(?:[|#][^\]]+)?\]\]/g)];
    for (const m of links) incomingCount.set(m[1].trim(), (incomingCount.get(m[1].trim()) ?? 0) + 1);
  }
  const orphans: string[] = [];
  for (const wf of wikiFiles) {
    if (skipOrphan.has(wf.relPath) || wf.fm.kind === "system" || wf.relPath.startsWith("wiki/索引/")) continue;
    // Skip ZInBox clippings — they're external, intentionally orphan
    const tags = String(wf.fm.tags ?? "");
    if (tags.includes("zinbox")) continue;
    const name = wf.relPath.replace(/\.md$/, "").replace("wiki/", "");
    const title = String(wf.fm.title ?? "");
    const inc = (incomingCount.get(wf.relPath.replace(/\.md$/, "")) ?? 0)
              + (incomingCount.get(name) ?? 0)
              + (incomingCount.get(title) ?? 0);
    if (inc === 0) orphans.push(wf.relPath);
  }

  // ── Find stale (>90 days since updated/compiled) ──
  const stale: string[] = [];
  const staleCutoff = new Date();
  staleCutoff.setDate(staleCutoff.getDate() - STALE_DAYS);
  const cutoffStr = staleCutoff.toISOString().split("T")[0];
  for (const wf of wikiFiles) {
    if (wf.fm.kind === "system") continue;
    const last = String(wf.fm.updated || wf.fm.compiled || "");
    if (last && last < cutoffStr) stale.push(wf.relPath);
  }

  // ── Missing concepts ──
  // (Call detectMissingConcepts here quick inline)
  // We reuse the existing logic in the lint tool. For this status page, we just count
  // how many missing concepts had been detected on last lint pass by checking log.
  // Since lint already runs, we can read the last lint result from log.md.
  let missingConceptCount = 0;
  try {
    const logPath = path.join(VAULT, "log.md");
    if (fs.existsSync(logPath)) {
      const logs = fs.readFileSync(logPath, "utf-8").split("\n").filter(l => l.startsWith("## ["));
      const lastLint = logs.filter(l => l.includes("lint |")).pop() ?? "";
      const match = lastLint.match(/warning[s]?:\s*(\d+)/);
      if (match) missingConceptCount = parseInt(match[1], 10) || 0;
    }
  } catch { /* non-fatal */ }

  // ── Build status ──
  const hasIssues = pendingCompile > 0 || pendingWeave > 0 || pendingLint > 0
    || stale.length > 0 || missingConceptCount > 0;
  const statusEmoji = hasIssues ? "🟡" : "🟢";
  const statusText = hasIssues ? "有需要关注的问题" : "一切正常";
  const orphanNote = orphans.length > 0 ? ` (${orphans.length} 个孤立节点 — 独立发现，不影响使用)` : "";

  const sections: string[] = [
    "---",
    `title: "LLM-Wiki 状态"`,
    "tags: [system, status]",
    `kind: system`,
    `updated: "${new Date().toISOString().slice(0, 19).replace("T", " ")}"`,
    "---",
    "",
    `# 🩺 LLM-Wiki 状态`,
    "",
    `> 自动生成 — 被动观察者只读页面`,
    "",
    `## ${statusEmoji} ${statusText}${orphanNote}`,
    "",
    `| 指标 | 值 |`,
    `|------|------|`,
    `| 编译 | ${compiled}/${total} |`,
    `| 织入 | ${weaved}/${total} |`,
    `| Lint | ${linted}/${total} |`,
    `| 待编译 | ${pendingCompile} |`,
    `| 孤立节点 | ${orphans.length} |`,
    `| 过期页面 | ${stale.length} |`,
    `| 概念缺页 | ${missingConceptCount} |`,
    `| Agent End 成功率 | ${agentEnd.ok + agentEnd.fail > 0 ? Math.round(agentEnd.ok / (agentEnd.ok + agentEnd.fail) * 100) + "%" : "N/A"} |`,
    `| 最近 ingest | ${agentEnd.lastOk || "-"} |`,
    "",
  ];

  // Only show detail sections when there are issues
  if (pendingCompile > 0 || pendingWeave > 0 || pendingLint > 0) {
    sections.push("---", "", "### ⏳ 管线待处理", "");
    if (pendingCompile > 0) sections.push(`- ${pendingCompile} 篇待编译`);
    if (pendingWeave > 0) sections.push(`- ${pendingWeave} 篇已编译待织入`);
    if (pendingLint > 0) sections.push(`- ${pendingLint} 篇已织入待 Lint`);
    sections.push("");
  }

  if (orphans.length > 0) {
    sections.push("---", "", "### 🔗 孤立节点", "");
    for (const o of orphans.slice(0, 10)) {
      sections.push(`- [[${o.replace(/\.md$/, "")}]] — 无入链`);
    }
    if (orphans.length > 10) sections.push(`- ...还有 ${orphans.length - 10} 个`);
    sections.push("");
  }

  if (stale.length > 0) {
    sections.push("---", "", "### ⏰ 过期页面 (>90天未更新)", "");
    for (const s of stale.slice(0, 5)) {
      sections.push(`- [[${s.replace(/\.md$/, "")}]]`);
    }
    if (stale.length > 5) sections.push(`- ...还有 ${stale.length - 5} 个`);
    sections.push("");
  }

  if (missingConceptCount > 0) {
    sections.push("---", "", "### 🧩 概念缺页", "");
    sections.push(`- ${missingConceptCount} 个概念缺页警告 — 运行 obs_lint 查看详情`);
    sections.push("");
  }

  sections.push("---", "", "> 状态页由 pi-llm-wiki 扩展在每次 Agent 会话启动时自动刷新。");

  return sections.join("\n");
}

/** Run lint summary (no issues, just counts). Used by refresh.ts for auto-lint logging. */
export function autoLint(): { errors: number; warnings: number; stale: number; orphans: number; total: number } {
  const rawFiles = readAllRaw();
  const wikiFiles = collectWikiFiles();
  const now = new Date().toISOString().split("T")[0];

  const staleCutoff = new Date();
  staleCutoff.setDate(staleCutoff.getDate() - STALE_DAYS);
  const cutoffStr = staleCutoff.toISOString().split("T")[0];

  const skipOrphan = new Set([
    "wiki/图谱.md", "wiki/仪表盘.md", "wiki/流程巡检.md", "wiki/问题追踪.md", "wiki/hot.md", PATHS.index, PATHS.dashboard, PATHS.hot, PATHS.inspection, PATHS.issues
  ]);

  // Orphan count
  const incomingCount = new Map<string, number>();
  const wikiTitles = new Map<string, string>();
  for (const wf of wikiFiles) {
    const title = String(wf.fm.title ?? "");
    if (title) wikiTitles.set(title, wf.relPath);
    const links = [...wf.content.matchAll(/\[\[([^\]|#]+?)(?:[|#][^\]]+)?\]\]/g)];
    for (const m of links) incomingCount.set(m[1].trim(), (incomingCount.get(m[1].trim()) ?? 0) + 1);
  }
  let orphans = 0;
  for (const wf of wikiFiles) {
    if (skipOrphan.has(wf.relPath) || wf.fm.kind === "system" || wf.relPath.startsWith("wiki/索引/")) continue;
    // Skip ZInBox tagged pages (external clippings, intentionally orphan)
    const tags = String(wf.fm.tags ?? "");
    if (tags.includes("zinbox")) continue;
    const name = wf.relPath.replace(/\.md$/, "").replace("wiki/", "");
    const title = String(wf.fm.title ?? "");
    const inc = (incomingCount.get(wf.relPath.replace(/\.md$/, "")) ?? 0)
              + (incomingCount.get(name) ?? 0)
              + (incomingCount.get(title) ?? 0);
    if (inc === 0) orphans++;
  }

  // Stale count
  let stale = 0;
  for (const wf of wikiFiles) {
    if (wf.fm.kind === "system") continue;
    const last = String(wf.fm.updated || wf.fm.compiled || "");
    if (last && last < cutoffStr) stale++;
  }

  const total = wikiFiles.filter((wf) => wf.fm.kind !== "system").length;
  const errors = 0;
  // Orphans are informational, not warnings — they're independent discoveries
  const warnings = stale;

  return { errors, warnings, stale, orphans, total };
}
