/**
 * pi-llm-wiki — Lightweight fs wrapper.
 * WSL2 has direct /mnt/d/ access to the Obsidian vault, so all operations
 * are synchronous fs calls. No REST API, no fallback, no async overhead.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { LLM_WIKI } from "./config";

/** Resolve a vault-relative path to absolute filesystem path */
function vaultFsPath(vaultRel: string): string {
  const clean = vaultRel.replace(/^\/?vault\//, "");
  return path.join(LLM_WIKI.vault, clean);
}

/** Read a file from the vault */
export function readFile(filePath: string): string {
  return fs.readFileSync(vaultFsPath(filePath), "utf-8");
}

/** Write a file to the vault (creates parent dirs) */
export function writeFile(filePath: string, content: string): void {
  const abs = vaultFsPath(filePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf-8");
}

/** Check if a file exists in the vault */
export function exists(filePath: string): boolean {
  return fs.existsSync(vaultFsPath(filePath));
}

/** List files in a vault directory */
export function listDir(dirPath: string): string[] {
  try {
    return fs.readdirSync(vaultFsPath(dirPath));
  } catch {
    return [];
  }
}

/** Append content to a file (creates if missing) */
export function appendToFile(filePath: string, line: string): void {
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
