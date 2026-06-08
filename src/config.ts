/**
 * pi-llm-wiki — Configuration constants and vault settings.
 */

import * as path from "node:path";

function getApiKey(): string {
  const key = process.env.OBSIDIAN_LLM_WIKI_KEY ?? process.env.OBSIDIAN_LLM_WIKI_SMART_KEY;
  if (!key) {
    throw new Error(
      "[pi-llm-wiki] OBSIDIAN_LLM_WIKI_KEY or OBSIDIAN_LLM_WIKI_SMART_KEY environment variable is required. " +
      "Get your key from Obsidian REST API plugin settings."
    );
  }
  return key;
}

export const LLM_WIKI = {
  /** Obsidian REST API endpoint (obsidian-api plugin, HTTPS, WSL2 mirrored) */
  api: "https://localhost:27124",
  /** Bearer token for REST API */
  get key() { return getApiKey(); },
  /** WSL2 filesystem path to vault */
  vault: "/mnt/d/DB/Obsidian/LLM-Wiki",
  /** Windows path (for Obsidian CLI / URI) */
  vaultWindows: "D:\\DB\\Obsidian\\LLM-Wiki",
};

const HOME = process.env.HOME ?? "/home";

export const PATHS = {
  schema: "schema.md",
  log: "log.md",
  index: "wiki/图谱.md",
  dashboard: "wiki/仪表盘.md",
  hot: "wiki/hot.md",
  inspection: "wiki/流程巡检.md",
  issues: "wiki/问题追踪.md",
  rawSessions: "raw/sessions",
  rawClippings: "raw/clippings",
  rawNotes: "raw/notes",
  /** Debug log (human-readable, append-only) */
  debug: path.join(HOME, ".pi/agent/pi-llm-wiki-debug.log"),
  /** Structured JSON log (for dashboard consumption) */
  structured: path.join(HOME, ".pi/agent/pi-llm-wiki.log"),
};

export const WIKI_TYPES = [
  "概念",
  "决策",
  "命令",
  "流程",
  "记忆",
  "项目",
  "发现",
  "索引",
  "规则",
  "引用",
] as const;

/** Compile threshold: trigger obs-compile when raw sessions >= this */
export const COMPILE_THRESHOLD = 5;

/** Single session ingest max chars */
export const INGEST_MAX_CHARS = 500;

/** obs-query default result limit */
export const QUERY_DEFAULT_LIMIT = 3;

/** Days before marking content as stale */
export const STALE_DAYS = 90;

/** Cross-page analysis thresholds */
export const ANALYSIS = {
  /** Report concepts referenced ≥N times but lacking a page */
  MISSING_CONCEPT_THRESHOLD: 3,
  /** Jaccard similarity threshold for finding related pages during weave */
  WEAVE_RELEVANCE_THRESHOLD: 0.2,
  /** Max pages to touch in one weave pass */
  WEAVE_MAX_CONTACTS: 10,
} as const;
