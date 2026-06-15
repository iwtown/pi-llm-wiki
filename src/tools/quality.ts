/**
 * pi-llm-wiki — Quality scoring for wiki pages (Layer 4).
 * Computes and maintains quality_score (1-5) for every wiki page.
 * Runs as part of pipeline (lint) and on query tracking.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { LLM_WIKI, PATHS } from "../config";
import { collectWikiPages } from "../system/analyzer";
import type { WikiPage } from "../system/analyzer";
import { parseFrontmatter } from "../system/parse";
import { dlog, slog } from "../system/log";

const VAULT = LLM_WIKI.vault;

/** Today's date string (cached once per process) */
const todayStr = new Date().toISOString().split("T")[0];

/** Compute days between a date string (YYYY-MM-DD) and today */
function daysSince(dateStr: string): number {
  const d = new Date(dateStr + "T00:00:00");
  return Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
}

export interface QualityInfo {
  path: string;
  title: string;
  quality_score: number;
  confidence: number;
  queried_count: number;
  last_queried: string | null;
  days_since_query: number | null;
  stale: boolean;
}

/**
 * Compute quality_score for a single page based on:
 * - confidence (compile-time, or default 3)
 * - queried_count (each query adds bonus)
 * - days_since_last_query (decay penalty)
 *
 * Formula: base + query_bonus - decay_penalty, clamped to [1, 5]
 */
export function computeQualityScore(
  confidence: number,
  queriedCount: number,
  daysSinceQuery: number | null,
): number {
  const base = Math.max(confidence, 1); // 1-5
  const queryBonus = Math.min(queriedCount * 0.5, 2); // max +2 from queries

  // Decay: -0.5 per 30 days without query, starting after 30 days
  let decay = 0;
  if (daysSinceQuery !== null && daysSinceQuery > 30) {
    decay = Math.floor((daysSinceQuery - 30) / 30) * 0.5;
  }

  const score = base + queryBonus - decay;
  return Math.max(1, Math.min(5, Math.round(score)));
}

/** Replace or insert a frontmatter field */
function setFmField(content: string, key: string, value: string | number): string {
  const re = new RegExp(`^(\\s*)${key}:\\s*.*$`, "m");
  if (re.test(content)) {
    return content.replace(re, `$1${key}: ${value}`);
  }
  // Insert before the closing ---
  const fmEndMatch = content.match(/^---\n[\s\S]*?\n---/);
  if (fmEndMatch) {
    const fmEnd = fmEndMatch[0];
    const insert = fmEnd.replace(/\n---$/, `\n${key}: ${value}\n---`);
    return content.replace(fmEnd, insert);
  }
  return content;
}

/**
 * Compute & persist quality fields for a page given its raw content.
 * Returns null on failure, QualityInfo on success (even if nothing changed).
 */
function scoreAndWrite(filePath: string, content: string): QualityInfo | null {
  try {
    const fm = parseFrontmatter(content);

    const confidence = typeof fm.confidence === "number" ? fm.confidence : 3;
    const queriedCount = typeof fm.queried_count === "number" ? fm.queried_count : 0;
    const lastQueriedStr = typeof fm.last_queried === "string" ? fm.last_queried : null;
    const title = typeof fm.title === "string" ? fm.title : path.basename(filePath, ".md");

    // Adjust confidence for content richness: auto-compiled pages that are empty
    // (no insights, tiny body) get penalized so they rank below useful pages.
    // Manually written pages (no compiled_by) are NOT penalized.
    // Additionally, pages marked as stale get a floor of 2 to exclude them from preview.
    const compiledBy = typeof fm.compiled_by === "string" ? fm.compiled_by : null;
    const isStale = fm.status === "stale";
    let emptyPenalty = 0;
    if (compiledBy) {
      const body = content.replace(/^---[\s\S]*?\n---\n/, "").trim();
      const bodyLen = body.length;
      const insightCount = (content.match(/^- /g) || []).length;
      if (insightCount === 0 && bodyLen > 0) emptyPenalty += 1;      // knowledge-empty
      if (bodyLen < 300) emptyPenalty += 0.5;                         // content-thin
    }
    const adjustedConfidence = Math.max(Math.round(confidence - emptyPenalty), 1);

    const daysQ = lastQueriedStr ? daysSince(lastQueriedStr) : null;
    let qualityScore = computeQualityScore(adjustedConfidence, queriedCount, daysQ);
    if (isStale) qualityScore = Math.min(qualityScore, 2);            // stale pages excluded from preview
    const stale = daysQ !== null && daysQ > 90;

    // Check if any field changed
    const oldScore = typeof fm.quality_score === "number" ? fm.quality_score : null;
    const oldDaysQ = typeof fm.days_since_query === "number" ? fm.days_since_query : null;
    const oldStale = fm.stale === true;

    if (oldScore === qualityScore && oldDaysQ === daysQ && oldStale === stale) {
      // No change needed
      return {
        path: filePath, title, quality_score: qualityScore, confidence,
        queried_count: queriedCount, last_queried: lastQueriedStr,
        days_since_query: daysQ, stale,
      };
    }

    // Build human-readable quality_reason
    const reasons: string[] = [`confidence:${confidence}`];
    if (emptyPenalty > 0) reasons.push(`penalty:-${emptyPenalty}`);
    if (queriedCount > 0) reasons.push(`queries:${queriedCount}`);
    if (daysQ !== null && daysQ > 30) reasons.push(`decay:-${Math.floor(daysQ / 30) * 0.5}`);
    if (isStale) reasons.push(`stale_floor:2`);
    const reasonStr = reasons.join(", ");

    let updated = content;
    if (oldScore !== qualityScore) {
      updated = setFmField(updated, "quality_score", qualityScore);
      updated = setFmField(updated, "quality_reason", reasonStr);
    }
    if (oldDaysQ !== daysQ && daysQ !== null) updated = setFmField(updated, "days_since_query", daysQ);
    if (oldStale !== stale) updated = setFmField(updated, "stale", stale ? "true" : "false");

    const fullPath = path.join(VAULT, filePath);
    fs.writeFileSync(fullPath, updated, "utf-8");

    return {
      path: filePath, title, quality_score: qualityScore, confidence,
      queried_count: queriedCount, last_queried: lastQueriedStr,
      days_since_query: daysQ, stale,
    };
  } catch {
    return null;
  }
}

/**
 * Update quality_score for a single wiki page by path.
 * Reads the file, computes score, writes it back.
 */
export function updatePageQuality(filePath: string): QualityInfo | null {
  try {
    const fullPath = path.join(VAULT, filePath);
    const content = fs.readFileSync(fullPath, "utf-8");
    return scoreAndWrite(filePath, content);
  } catch {
    return null;
  }
}

/**
 * Bulk update quality scores for all wiki pages.
 * Returns a quality report summary.
 */
export interface QualityReport {
  total: number;
  healthy: number;   // quality >= 4
  fair: number;      // quality 3
  low: number;       // quality < 3
  stale: number;     // not queried for 90+ days
  topQueried: { path: string; title: string; count: number }[];
  details: QualityInfo[];
}

/**
 * Run full quality assessment on all wiki pages.
 * Uses collectWikiPages() once — no per-page file reads.
 */
export interface ProjectIndexEntry {
  path: string;
  title: string;
  quality_score: number;
}

export interface ProjectIndex {
  version: number;
  updated: string;
  projects: Record<string, ProjectIndexEntry[]>;
}

/**
 * Build and persist lightweight project index for fast session-start lookup.
 * Maps project name → sorted pages (quality_score desc, ≥3 only).
 */
export function buildProjectIndex(pages: WikiPage[]): void {
  const projects: Record<string, ProjectIndexEntry[]> = {};

  const skipProjects = new Set(["_home_wtown_", "home", "wtown", "unknown", "发现", "gsd-v2".toLowerCase()]);
  for (const page of pages) {
    if (!page.path.startsWith("wiki/")) continue;
    if (!page.project) continue;

    const fm = parseFrontmatter(page.content);
    const qs = typeof fm.quality_score === "number" ? fm.quality_score : 3;
    if (qs < 3) continue;

    const title = typeof fm.title === "string" ? fm.title : path.basename(page.path, ".md");

    const proj = page.project.toLowerCase();
    // Skip path-encoded project names (e.g. _home_wtown_projects_pi_)
    // and known non-project names. These come from crash-recovery sessions
    // or sessions where project detection failed.
    if (proj.startsWith("_home") || skipProjects.has(proj)) continue;
    if (!projects[proj]) projects[proj] = [];
    projects[proj].push({ path: page.path, title, quality_score: qs });
  }

  // Sort each project's pages by quality_score descending
  for (const proj of Object.keys(projects)) {
    projects[proj].sort((a, b) => b.quality_score - a.quality_score);
  }

  const index: ProjectIndex = {
    version: 1,
    updated: todayStr,
    projects,
  };

  const indexPath = path.join(VAULT, PATHS.projectIndex);
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), "utf-8");
}

export function assessAllQuality(): QualityReport {
  const pages = collectWikiPages();
  const allInfo: QualityInfo[] = [];

  for (const page of pages) {
    if (!page.path.startsWith("wiki/")) continue;
    const info = scoreAndWrite(page.path, page.content);
    if (info) allInfo.push(info);
  }

  // Build project index for fast session-start lookup
  buildProjectIndex(pages);

  const healthy = allInfo.filter((i) => i.quality_score >= 4);
  const fair = allInfo.filter((i) => i.quality_score === 3);
  const low = allInfo.filter((i) => i.quality_score < 3);
  const stale = allInfo.filter((i) => i.stale);

  // Top 10 most-queried pages (sorted by queried_count desc)
  const topQueried = allInfo
    .filter((i) => i.queried_count > 0)
    .sort((a, b) => b.queried_count - a.queried_count)
    .slice(0, 10)
    .map((i) => ({ path: i.path, title: i.title, count: i.queried_count }));

  const report: QualityReport = {
    total: allInfo.length,
    healthy: healthy.length,
    fair: fair.length,
    low: low.length,
    stale: stale.length,
    topQueried,
    details: allInfo,
  };

  slog("quality_assessment", {
    total: report.total,
    healthy: report.healthy,
    fair: report.fair,
    low: report.low,
    stale: report.stale,
  });

  // Log summary
  const pctHealthy = ((report.healthy / report.total) * 100).toFixed(0);
  dlog(
    `Quality: ${report.total} pages | ✅ ${report.healthy} (${pctHealthy}%) healthy` +
    (report.low > 0 ? ` | ⚠️ ${report.low} low` : "") +
    (report.stale > 0 ? ` | 🗄️ ${report.stale} stale` : "")
  );
  if (report.topQueried.length > 0) {
    dlog(
      `📊 Top queried: ${report.topQueried.slice(0, 5).map((q) => `${q.title}(${q.count})`).join(", ")}`
    );
  }

  // Auto-cleanup: delete auto-compiled stale pages that are empty and > 30 days old
  // Stale empty pages clutter the wiki and degrade search quality.
  // Only pages with explicit `status: stale` frontmatter AND empty body get deleted.
  let deletedCount = 0;
  for (const page of pages) {
    if (!page.path.startsWith("wiki/")) continue;
    const fm = parseFrontmatter(page.content);
    if (fm.status !== "stale") continue;                      // only explicitly-marked stale
    if (typeof fm.compiled_by !== "string") continue;          // only auto-compiled pages
    
    const created = typeof fm.created === "string" ? fm.created : null;
    if (!created) continue;
    const daysOld = daysSince(created);
    if (daysOld === null || daysOld < 30) continue;           // keep recent stale pages
    
    // Check body is empty (no substantive content)
    const body = page.content.replace(/^---[\s\S]*?\n---\n/, "").trim();
    const insightCount = (page.content.match(/^- /g) || []).length;
    if (insightCount > 0 || body.length > 500) continue;      // has real content — keep
    
    // Delete the page
    const fullPath = path.join(VAULT, page.path);
    try {
      // Move to a trash dir as safety measure instead of permanent delete
      const trashDir = path.join(VAULT, "wiki/索引/trash");
      fs.mkdirSync(trashDir, { recursive: true });
      const trashPath = path.join(trashDir, path.basename(page.path));
      fs.renameSync(fullPath, trashPath);
      slog("auto_cleanup", { path: page.path, reason: "stale empty auto-compiled page", movedTo: trashPath });
      dlog(`🗑️ Cleaned up stale empty page: ${page.path} → ${trashPath}`);
      deletedCount++;
    } catch (e: any) {
      slog("auto_cleanup_failed", { path: page.path, error: e.message });
    }
  }
  if (deletedCount > 0) {
    dlog(`🧹 Auto-cleaned ${deletedCount} empty stale pages`);
  }

  return report;
}
