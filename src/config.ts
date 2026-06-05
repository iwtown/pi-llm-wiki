/**
 * pi-llm-wiki — Configuration constants and vault settings.
 */

function getApiKey(): string {
  const envKey = process.env.OBSIDIAN_LLM_WIKI_KEY;
  if (envKey) return envKey;
  // Fallback for dev — emit console warning once
  if (!keyWarned) {
    keyWarned = true;
    console.warn("[pi-llm-wiki] OBSIDIAN_LLM_WIKI_KEY not set, using hardcoded fallback. Set this env var.");
  }
  return "5b484f2a70fb254383feaed8fe92604841f5fd2eda221e1fa8ec0e50839b1a9e";
}
let keyWarned = false;

export const LLM_WIKI = {
  /** Obsidian REST API endpoint (WSL2 mirrored networking) */
  api: "http://localhost:27126",
  /** Bearer token for REST API */
  get key() { return getApiKey(); },
  /** WSL2 filesystem path to vault */
  vault: "/mnt/d/DB/Obsidian/LLM-Wiki",
  /** Windows path (for Obsidian CLI / URI) */
  vaultWindows: "D:\\DB\\Obsidian\\LLM-Wiki",
};

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
