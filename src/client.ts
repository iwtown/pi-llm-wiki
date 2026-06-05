/**
 * pi-llm-wiki — Obsidian REST API client.
 * Wraps Obsidian Local REST API for CRUD operations on the LLM-Wiki vault.
 */

import { LLM_WIKI } from "./config";

interface ApiError {
  error: string;
  message?: string;
}

async function request<T = unknown>(
  method: string,
  path: string,
  body?: string,
  contentType = "text/markdown"
): Promise<T> {
  const url = `${LLM_WIKI.api}${path}`;
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
    throw new Error(`Obsidian API ${method} ${path}: ${msg}`);
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

/** List files in a directory */
export async function listDir(dirPath: string): Promise<string[]> {
  const res = await request<{ files: Array<{ name: string }> }>(
    "GET",
    `/vault/${dirPath}/`
  );
  return (res.files ?? []).map((f) => f.name);
}

/** Read a file from the vault (returns markdown string) */
export async function readFile(filePath: string): Promise<string> {
  return request<string>("GET", `/vault/${filePath}`);
}

/** Create or update a file */
export async function writeFile(
  filePath: string,
  content: string
): Promise<void> {
  await request("PUT", `/vault/${filePath}`, content);
}

/** Delete a file */
export async function deleteFile(filePath: string): Promise<void> {
  await request("DELETE", `/vault/${filePath}`);
}

/** Search the vault (full-text) */
export interface SearchResult {
  filename: string;
  score: number;
  matches: Array<{ context: string; match: string }>;
}

export async function search(
  query: string,
  limit = 20
): Promise<SearchResult[]> {
  const params = new URLSearchParams({ query, contextLength: "200" });
  const res = await request<SearchResult[]>(
    "GET",
    `/search/simple/?${params.toString()}`
  );
  return (res ?? []).slice(0, limit);
}

/** Check if a file exists */
export async function exists(filePath: string): Promise<boolean> {
  try {
    await request("GET", `/vault/${filePath}`);
    return true;
  } catch {
    return false;
  }
}

/** Append a line to a file (used for log.md) */
export async function appendToFile(
  filePath: string,
  line: string
): Promise<void> {
  let content = "";
  try {
    content = await readFile(filePath);
  } catch {
    // file doesn't exist yet, create it
    content = "";
  }
  content += (content && !content.endsWith("\n") ? "\n" : "") + line + "\n";
  await writeFile(filePath, content);
}
