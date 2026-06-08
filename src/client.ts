/**
 * pi-llm-wiki — Obsidian REST API client with filesystem fallback.
 * Wraps Obsidian Local REST API for CRUD operations on the LLM-Wiki vault.
 * Every function auto-degrades to direct filesystem access when API is down.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { LLM_WIKI } from "./config";

interface ApiError {
  error: string;
  message?: string;
}

// ─── Filesystem helpers ───

/** Resolve a vault-relative path (e.g. "wiki/概念/foo.md") to absolute filesystem path */
function vaultFsPath(vaultRel: string): string {
  // Strip leading /vault/ if present (API response style)
  const clean = vaultRel.replace(/^\/?vault\//, "");
  return path.join(LLM_WIKI.vault, clean);
}

async function request<T = unknown>(
  method: string,
  apiPath: string,
  body?: string,
  contentType = "text/markdown"
): Promise<T> {
  const url = `${LLM_WIKI.api}${apiPath}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${LLM_WIKI.key}`,
  };
  if (body !== undefined) {
    headers["Content-Type"] = contentType;
  }

  const res = await fetch(url, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const err = (await res.json()) as ApiError;
      if (err.message) msg = err.message;
      if (err.error) msg = err.error;
    } catch {
      // non-JSON response
    }
    throw new Error(`Obsidian API ${method} ${apiPath}: ${msg}`);
  }

  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

/** Check API connectivity */
export async function ping(): Promise<boolean> {
  try {
    await request("GET", "/");
    return true;
  } catch {
    return false;
  }
}

/** List files in a directory — API → fs fallback */
export async function listDir(dirPath: string): Promise<string[]> {
  try {
    const res = await request<{ files: Array<{ name: string }> }>(
      "GET",
      `/vault/${dirPath}/`
    );
    return (res.files ?? []).map((f) => f.name);
  } catch {
    // Fallback: read filesystem
    try {
      const abs = vaultFsPath(dirPath);
      return fs.readdirSync(abs);
    } catch {
      return [];
    }
  }
}

/** Read a file from the vault — API → fs fallback */
export async function readFile(filePath: string): Promise<string> {
  try {
    return await request<string>("GET", `/vault/${filePath}`);
  } catch {
    // Fallback: read filesystem
    const abs = vaultFsPath(filePath);
    return fs.readFileSync(abs, "utf-8");
  }
}

/** Create or update a file — API → fs fallback */
export async function writeFile(
  filePath: string,
  content: string
): Promise<void> {
  try {
    await request("PUT", `/vault/${filePath}`, content);
  } catch {
    // Fallback: write filesystem
    const abs = vaultFsPath(filePath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf-8");
  }
}

/** Delete a file — API → fs fallback */
export async function deleteFile(filePath: string): Promise<void> {
  try {
    await request("DELETE", `/vault/${filePath}`);
  } catch {
    // Fallback: delete on filesystem
    try {
      fs.unlinkSync(vaultFsPath(filePath));
    } catch {
      // file may not exist — non-fatal
    }
  }
}

/** Search the vault (full-text) — POST with plain text body */
export interface SearchResult {
  filename: string;
  score: number;
  matches: Array<{ context: string; match: string }>;
}

export async function search(
  query: string,
  limit = 20
): Promise<SearchResult[]> {
  try {
    const res = await request<SearchResult[]>(
      "POST",
      "/search/simple/",
      query,
      "text/plain"
    );
    return (res ?? []).slice(0, limit);
  } catch {
    return [];
  }
}

/* ───────── Smart Connections semantic search ───────── */

export interface SmartSearchResult {
  path: string;
  text: string;
  score: number;
  breadcrumbs: string;
}

/** Semantic search via Smart Connections (POST JSON, /search/smart) */
export async function smartSearch(
  query: string,
  limit = 10
): Promise<SmartSearchResult[]> {
  try {
    const res = await request<{ results: SmartSearchResult[] }>(
      "POST",
      "/search/smart",
      JSON.stringify({ query, limit }),
      "application/json"
    );
    return (res.results ?? []).slice(0, limit);
  } catch {
    return [];
  }
}

/** Check if a file exists — API → fs fallback */
export async function exists(filePath: string): Promise<boolean> {
  try {
    await request("GET", `/vault/${filePath}`);
    return true;
  } catch {
    try {
      return fs.existsSync(vaultFsPath(filePath));
    } catch {
      return false;
    }
  }
}

/** Append a line to a file (used for log.md) — API → fs fallback */
export async function appendToFile(
  filePath: string,
  line: string
): Promise<void> {
  // Try API first
  try {
    let content = "";
    try {
      content = await request<string>("GET", `/vault/${filePath}`);
    } catch {
      // file doesn't exist yet
    }
    content += (content && !content.endsWith("\n") ? "\n" : "") + line + "\n";
    await request("PUT", `/vault/${filePath}`, content);
    return;
  } catch {
    // Fallback: filesystem append
    const abs = vaultFsPath(filePath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    let content = "";
    try {
      content = fs.readFileSync(abs, "utf-8");
    } catch {
      // file doesn't exist yet
    }
    content += (content && !content.endsWith("\n") ? "\n" : "") + line + "\n";
    fs.writeFileSync(abs, content, "utf-8");
  }
}
