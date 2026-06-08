/**
 * pi-llm-wiki — Obsidian vault filesystem access with REST API fallback.
 * Wraps direct filesystem CRUD on the LLM-Wiki vault.
 * Reads & writes go fs-first because WSL2 has direct /mnt/d/ access.
 * REST API is only a fallback when local fs is unavailable.
 * Search ops keep API-first because Omnisearch/SmartConnections have no fs equivalent.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { LLM_WIKI } from "./config";

interface ApiError {
  error: string;
  message?: string;
}

// ─── Filesystem helpers ───

/** Resolve a vault-relative path to absolute filesystem path */
function vaultFsPath(vaultRel: string): string {
  const clean = vaultRel.replace(/^\/?vault\//, "");
  return path.join(LLM_WIKI.vault, clean);
}

async function apiRequest<T = unknown>(
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
    await apiRequest("GET", "/");
    return true;
  } catch {
    return false;
  }
}

// ─── CRUD: all fs-first (fast, no API cost) ───

/** List files in a directory — fs → API */
export async function listDir(dirPath: string): Promise<string[]> {
  try {
    const abs = vaultFsPath(dirPath);
    return fs.readdirSync(abs);
  } catch {
    try {
      const res = await apiRequest<{ files: Array<{ name: string }> }>(
        "GET",
        `/vault/${dirPath}/`
      );
      return (res.files ?? []).map((f) => f.name);
    } catch {
      return [];
    }
  }
}

/** Read a file — fs → API */
export async function readFile(filePath: string): Promise<string> {
  try {
    const abs = vaultFsPath(filePath);
    return fs.readFileSync(abs, "utf-8");
  } catch {
    return await apiRequest<string>("GET", `/vault/${filePath}`);
  }
}

/** Write a file — fs → API */
export async function writeFile(
  filePath: string,
  content: string
): Promise<void> {
  try {
    const abs = vaultFsPath(filePath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf-8");
  } catch {
    await apiRequest("PUT", `/vault/${filePath}`, content);
  }
}

/** Delete a file — fs → API */
export async function deleteFile(filePath: string): Promise<void> {
  try {
    if (fs.existsSync(vaultFsPath(filePath))) {
      fs.unlinkSync(vaultFsPath(filePath));
    }
  } catch {
    try {
      await apiRequest("DELETE", `/vault/${filePath}`);
    } catch {
      // non-fatal
    }
  }
}

/** Check if a file exists — fs → API */
export async function exists(filePath: string): Promise<boolean> {
  try {
    return fs.existsSync(vaultFsPath(filePath));
  } catch {
    try {
      await apiRequest("GET", `/vault/${filePath}`);
      return true;
    } catch {
      return false;
    }
  }
}

/** Append a line to a file — fs → API */
export async function appendToFile(
  filePath: string,
  line: string
): Promise<void> {
  try {
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
  } catch {
    try {
      let content = "";
      try {
        content = await apiRequest<string>("GET", `/vault/${filePath}`);
      } catch {
        // file doesn't exist yet
      }
      content += (content && !content.endsWith("\n") ? "\n" : "") + line + "\n";
      await apiRequest("PUT", `/vault/${filePath}`, content);
    } catch {
      // non-fatal
    }
  }
}

// ─── Search: API-first (Omnisearch/SmartConnections better than fs grep) ───

export interface SearchResult {
  filename: string;
  score: number;
  matches: Array<{ context: string; match: string }>;
}

/** Full-text search — API (Omnisearch) → fs grep fallback */
export async function search(
  query: string,
  limit = 20
): Promise<SearchResult[]> {
  try {
    const res = await apiRequest<SearchResult[]>(
      "POST",
      "/search/simple/",
      query,
      "text/plain"
    );
    return (res ?? []).slice(0, limit);
  } catch {
    // Fallback: grep via rg
    const results: SearchResult[] = [];
    try {
      const safeQuery = query.replace(/"/g, '\\"');
      const grep = execSync(
        `rg -l -i "${safeQuery}" "${LLM_WIKI.vault}/wiki/"`,
        { timeout: 5000, encoding: "utf-8" }
      )
        .trim()
        .split("\n")
        .filter(Boolean)
        .slice(0, limit);
      for (const f of grep) {
        const rel = path.relative(LLM_WIKI.vault, f);
        results.push({ filename: rel, score: 1, matches: [] });
      }
    } catch {
      // rg not available or failed
    }
    return results;
  }
}

export interface SmartSearchResult {
  path: string;
  text: string;
  score: number;
  breadcrumbs: string;
}

/** Semantic search — API only (no fs equivalent). Returns empty on API failure. */
export async function smartSearch(
  query: string,
  limit = 10
): Promise<SmartSearchResult[]> {
  try {
    const res = await apiRequest<{ results: SmartSearchResult[] }>(
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
