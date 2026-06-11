/**
 * pi-llm-wiki — Change log for incremental processing (Phase 3).
 *
 * Tracks filesystem changes so before_agent_start can scan incrementally
 * instead of doing full directory walks of 700+ files every startup.
 *
 * Architecture:
 *   ingest/compile/weave → logChange({type, path, action})
 *   refresh.ts          → readChangeLog() for pending scan
 *                        → updateCache() after full scan
 *   status.ts           → getCachedFiles() for page lists
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS, CHANGE_LOG } from "../config";

// ── Types ──

export interface ChangeEntry {
  timestamp: string;
  type: "ingest" | "compile" | "weave" | "lint";
  path: string;
  action: "create" | "update" | "delete";
  wikiPath?: string;
}

export interface ChangeLog {
  version: number;
  lastFullScan: string;
  changes: ChangeEntry[];
  cache: {
    rawSessions: string[];
    wikiPages: string[];
    lastScanned: string;
  } | null;
}

// ── Read / Write ──

const CHANGES_PATH = PATHS.changes;

export function readChangeLog(): ChangeLog {
  try {
    const data = fs.readFileSync(CHANGES_PATH, "utf-8");
    return JSON.parse(data) as ChangeLog;
  } catch {
    return {
      version: 1,
      lastFullScan: new Date().toISOString(),
      changes: [],
      cache: null,
    };
  }
}

export function writeChangeLog(cl: ChangeLog): void {
  try {
    fs.mkdirSync(path.dirname(CHANGES_PATH), { recursive: true });
    fs.writeFileSync(CHANGES_PATH, JSON.stringify(cl, null, 2));
  } catch {
    // non-fatal
  }
}

// ── Operations ──

export function logChange(entry: ChangeEntry): void {
  try {
    const cl = readChangeLog();
    cl.changes.push(entry);

    // Keep only last MAX_ENTRIES
    if (cl.changes.length > CHANGE_LOG.MAX_ENTRIES) {
      cl.changes = cl.changes.slice(-CHANGE_LOG.MAX_ENTRIES);
    }

    writeChangeLog(cl);
  } catch {
    // non-fatal
  }
}

export function getCachedFiles(): { raw: string[]; wiki: string[]; lastScanned: string } {
  const cl = readChangeLog();
  if (!cl.cache) return { raw: [], wiki: [], lastScanned: "" };
  return {
    raw: cl.cache.rawSessions,
    wiki: cl.cache.wikiPages,
    lastScanned: cl.cache.lastScanned,
  };
}

export function updateCache(rawFiles: string[], wikiFiles: string[]): void {
  try {
    const cl = readChangeLog();
    cl.cache = {
      rawSessions: rawFiles,
      wikiPages: wikiFiles,
      lastScanned: new Date().toISOString(),
    };
    writeChangeLog(cl);
  } catch {
    // non-fatal
  }
}

/** Check if a vault-relative path is for a non-md or system file (not pending-scan material) */
export function isRelevantPendingPath(vaultRel: string): boolean {
  if (!vaultRel.startsWith("raw/sessions/")) return false;
  if (!vaultRel.endsWith(".md")) return false;
  // Skip crash-recovery markers (orphan cleanup)
  if (vaultRel.includes("crash-recovery")) return false;
  return true;
}

/** Determine if a full scan is needed (cache missing or expired) */
export function needsFullScan(): boolean {
  const cl = readChangeLog();
  if (!cl.cache) return true;
  if (cl.cache.rawSessions.length === 0 && cl.cache.wikiPages.length === 0) return true;
  const ageHrs =
    (Date.now() - new Date(cl.cache.lastScanned).getTime()) / 3600000;
  return ageHrs > CHANGE_LOG.FULL_SCAN_INTERVAL_HOURS;
}
