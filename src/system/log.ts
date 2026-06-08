/**
 * pi-llm-wiki — Shared logging utilities.
 * Single source of truth for dlog, fileDlog, and structured slog.
 */

import * as fs from "node:fs";
import { PATHS } from "../config";

const SLOG_MAX_BYTES = 1_000_000; // 1MB rotation threshold

/** Debug message to stderr (used everywhere) */
export function dlog(msg: string, origin = "pi-llm-wiki"): void {
  console.error(`[${origin}] ${msg}`);
}

/** Debug message to file + stderr (used by agent-end for persistence) */
export function fileDlog(msg: string): void {
  const ts = new Date().toISOString();
  console.error(`[pi-llm-wiki] ${msg}`);
  try {
    fs.appendFileSync(PATHS.debug, `[${ts}] ${msg}\n`);
  } catch {
    // non-fatal
  }
}

/** Structured JSON log event (for dashboard consumption) */
export function slog(event: string, data: Record<string, unknown> = {}): void {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + "\n";
    const logPath = PATHS.structured;

    // Rotate if oversized
    try {
      const stat = fs.statSync(logPath);
      if (stat.size > SLOG_MAX_BYTES) {
        const bak = `${logPath}.1`;
        if (fs.existsSync(bak)) fs.unlinkSync(bak);
        fs.renameSync(logPath, bak);
      }
    } catch {
      // first write or stat fail — proceed
    }

    fs.appendFileSync(logPath, line);
  } catch {
    // non-fatal
  }
}
