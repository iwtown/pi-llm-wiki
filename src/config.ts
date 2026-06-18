/**
 * pi-llm-wiki — Configuration constants and vault settings.
 */

import * as path from "node:path";

export const LLM_WIKI = {
  /* WSL2 filesystem path to vault — overridable via LLM_WIKI_VAULT (canonical) or LLM_WIKI_TEST_VAULT (compat) */
  vault: process.env.LLM_WIKI_VAULT || process.env.LLM_WIKI_TEST_VAULT || "/mnt/d/DB/Obsidian/LLM-Wiki",
  /** External clipping vault (ZInBox) — search-only, no copy */
  zinbox: process.env.LLM_WIKI_ZINBOX || process.env.LLM_WIKI_TEST_ZINBOX || "/mnt/d/DB/Obsidian/ZInBox",
  /** ZInBox compile tracker (small marker files, no content copy) */
  get zinboxIndex() { return this.vault + "/raw/zinbox-index"; },
};

const HOME = process.env.HOME ?? "/home";

export const PATHS = {
  /** Runtime rules — injected into system prompt at session start (~800 tokens) */
  schema: "schema.md",
  log: "log.md",
  index: "wiki/图谱.md",
  rawSessions: "raw/sessions",
  rawClippings: "raw/clippings",
  rawNotes: "raw/notes",
  /** Debug log (human-readable, append-only) */
  debug: path.join(HOME, ".pi/agent/pi-llm-wiki-debug.log"),
  /** Structured JSON log (for dashboard consumption) */
  structured: path.join(HOME, ".pi/agent/pi-llm-wiki.log"),
  /** Change log for incremental processing (Phase 3) */
  changes: path.join(HOME, ".pi/agent/pi-llm-wiki-changes.json"),
  /** Lightweight project index — built by pipeline, read at session start */
  projectIndex: "wiki/索引/项目索引.json",
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
  "提示",
] as const;

/** Pipeline status enum (Phase 5: replaces compiled/weaved/linted booleans) */
export type PipelineStatus = 'pending' | 'compiled' | 'woven' | 'done' | 'skipped';

export const PIPELINE_STATUS = {
  PENDING: 'pending' as const,
  COMPILED: 'compiled' as const,
  WOVEN: 'woven' as const,
  DONE: 'done' as const,
  SKIPPED: 'skipped' as const,
} satisfies Record<string, PipelineStatus>;

/** Compile threshold: warn when raw sessions pending >= this (raised from 5 to reduce noise) */
export const COMPILE_THRESHOLD = 5;

/** LLM configuration for compile-time extraction (all env-overridable) */
export const LLM_CONFIG = {
  /** Primary model — override via LLM_WIKI_EXTRACT_MODEL */
  model: process.env.LLM_WIKI_EXTRACT_MODEL || "glm-4-flash-250414",
  /** Primary API endpoint — override via LLM_WIKI_EXTRACT_ENDPOINT */
  endpoint: process.env.LLM_WIKI_EXTRACT_ENDPOINT || "https://open.bigmodel.cn/api/paas/v4/chat/completions",
  /** Environment variable name for API key */
  keyVar: "ZHIPU_API_KEY",
  /** Timeout for LLM calls (ms) — override via LLM_WIKI_EXTRACT_TIMEOUT_MS */
  timeoutMs: Number(process.env.LLM_WIKI_EXTRACT_TIMEOUT_MS) || 15_000,
  /** Max tokens for LLM output — override via LLM_WIKI_EXTRACT_MAX_TOKENS */
  maxTokens: Number(process.env.LLM_WIKI_EXTRACT_MAX_TOKENS) || 1000,
  /** Context chars to send to LLM (body slice) — override via LLM_WIKI_EXTRACT_CONTEXT_CHARS */
  contextChars: Number(process.env.LLM_WIKI_EXTRACT_CONTEXT_CHARS) || 4000,
  /** Temperature for extraction calls — override via LLM_WIKI_EXTRACT_TEMPERATURE */
  temperature: Number(process.env.LLM_WIKI_EXTRACT_TEMPERATURE) || 0.1,
  /** Temperature for distillation calls (higher for creative title/summary) — override via LLM_WIKI_DISTILL_TEMPERATURE */
  distillTemperature: Number(process.env.LLM_WIKI_DISTILL_TEMPERATURE) || 0.3,
  /** Max concurrent LLM API calls (for batch compile/ingest) — override via LLM_WIKI_MAX_CONCURRENCY */
  maxConcurrency: Number(process.env.LLM_WIKI_MAX_CONCURRENCY) || 3,
  /** Max retry attempts on 429/503 */
  maxRetries: 3,
  /** Base delay for exponential backoff (ms) */
  retryBaseDelayMs: 1000,
  /** Maximum delay between retries (ms) */
  maxRetryDelayMs: 10_000,
  /** Minimum interval between extraction requests (ms) — 15 RPM safe rate */
  minIntervalMs: 4000,
} as const;

/** Optional fallback LLM provider (e.g. DeepSeek official API) — used when primary is congested/fails */
export const LLM_FALLBACK_CONFIG = {
  /** Fallback model — set via LLM_WIKI_FALLBACK_MODEL */
  model: process.env.LLM_WIKI_FALLBACK_MODEL || "deepseek-v4-flash",
  /** Fallback endpoint — set via LLM_WIKI_FALLBACK_ENDPOINT */
  endpoint: process.env.LLM_WIKI_FALLBACK_ENDPOINT || "https://api.deepseek.com/v1/chat/completions",
  /** Environment variable name for fallback API key */
  keyVar: "DEEPSEEK_API_KEY",
  /** Timeout (ms) — override via LLM_WIKI_FALLBACK_TIMEOUT_MS */
  timeoutMs: Number(process.env.LLM_WIKI_FALLBACK_TIMEOUT_MS) || 15_000,
  /** Max tokens — override via LLM_WIKI_FALLBACK_MAX_TOKENS */
  maxTokens: Number(process.env.LLM_WIKI_FALLBACK_MAX_TOKENS) || 1000,
} as const;

/** Single session ingest max chars — raised from 500 to 3000 to preserve conversation context for GLM extraction */
export const INGEST_MAX_CHARS = 3000;

/** obs-query default result limit */
export const QUERY_DEFAULT_LIMIT = 3;

/** Days before marking content as stale */
export const STALE_DAYS = 90;

/** Change log configuration for incremental processing */
export const CHANGE_LOG = {
  /** Max entries to keep in change log */
  MAX_ENTRIES: 1000,
  /** Full scan interval (hours) */
  FULL_SCAN_INTERVAL_HOURS: 24,
} as const;

/** Cross-page analysis thresholds */
export const ANALYSIS = {
  /** Report concepts referenced ≥N times but lacking a page */
  MISSING_CONCEPT_THRESHOLD: 3,
  /** Jaccard similarity threshold for finding related pages during weave */
  WEAVE_RELEVANCE_THRESHOLD: 0.2,
  /** Max pages to touch in one weave pass */
  WEAVE_MAX_CONTACTS: 10,
} as const;
