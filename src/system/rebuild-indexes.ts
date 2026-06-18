/**
 * pi-llm-wiki — index.md generation for progressive disclosure.
 *
 * Inspired by OKF v0.1 §6 (index files for progressive disclosure).
 * Two entry points:
 *   - appendToDirIndex(wikiPath):  incremental, called after each compile
 *   - rebuildAllIndexes():          full rebuild, called during bulk pipeline
 *   - rebuildRootIndex():          root-level wiki/index.md
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { LLM_WIKI } from "../config";
import { readFile, writeFile, exists } from "../client";
import { dlog } from "./log";

const VAULT = LLM_WIKI.vault;

/** Excluded directories in wiki/ that don't need index.md */
const EXCLUDED_DIRS = new Set(["索引"]);

/** Extract first meaningful sentence from a wiki page body (after frontmatter). */
function extractBodySummary(content: string): string {
  const body = content.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (!t || /^#/.test(t) || /^[-*] /.test(t) || /^[=>]/.test(t)) continue;
    const s = t.replace(/^[^a-zA-Z0-9\u4e00-\u9fff]+/, "").slice(0, 80);
    if (s.length >= 5) return s;
  }
  return "";
}

/** Extract title and summary (with body fallback) from a wiki page. */
function parsePageMeta(content: string): { title: string; summary: string } {
  let title = "未命名";
  let summary = "";

  // Try quoted title first (standard compile output)
  const quotedTitle = content.match(/^title:\s*"([^"]*)"$/m);
  if (quotedTitle) {
    title = quotedTitle[1];
  } else {
    // Fallback: unquoted title
    const unquotedTitle = content.match(/^title:\s*(.+?)\s*$/m);
    if (unquotedTitle) title = unquotedTitle[1].trim();
  }

  // Try quoted summary first
  const quotedSummary = content.match(/^summary:\s*"([^"]*)"$/m);
  if (quotedSummary) {
    summary = quotedSummary[1];
  } else {
    // Fallback: unquoted summary (often on a separate line with leading spaces)
    const unquotedSummary = content.match(/^summary:\s*(.+?)\s*$/m);
    if (unquotedSummary) summary = unquotedSummary[1].trim();
  }

  // Body fallback: if no summary in frontmatter, extract first meaningful sentence
  if (!summary) summary = extractBodySummary(content);

  return { title, summary };
}

/**
 * Incremental: append one entry to the directory's index.md.
 * Called from compile.ts after writing a new wiki page.
 * Preprends the entry (newest first), skips if already listed (idempotent).
 * Creates index.md with header if it doesn't exist yet.
 */
export function appendToDirIndex(wikiPath: string): void {
  try {
    // Read the wiki page to extract title/summary
    const content = readFile(wikiPath);
    const { title, summary } = parsePageMeta(content);
    const date = new Date().toISOString().split("T")[0];
    const entry = `* [${title}](${wikiPath}) — ${summary || date}`;

    // Determine the directory index path
    const dir = wikiPath.substring(0, wikiPath.lastIndexOf("/")); // "wiki/发现"
    const indexPath = `${dir}/index.md`;

    // Check exist first — readFile throws on missing file
    const existing = exists(indexPath) ? readFile(indexPath) : "";
    if (existing) {
      // Skip if this link is already present (idempotent)
      if (existing.includes(`](${wikiPath})`)) return;
      // Prepend: insert after the header block (after the first blank line)
      const headerEnd = existing.indexOf("\n\n");
      if (headerEnd !== -1) {
        const header = existing.substring(0, headerEnd + 2);
        const body = existing.substring(headerEnd + 2);
        writeFile(indexPath, header + entry + "\n" + body);
      } else {
        writeFile(indexPath, existing.trimEnd() + "\n" + entry + "\n");
      }
    } else {
      const dirName = dir.split("/").pop() || "";
      const header = `# ${dirName}\n\nAgent 逐级浏览入口。由管线自动维护。\n\n`;
      writeFile(indexPath, header + entry + "\n");
    }
  } catch (e: any) {
    dlog("appendToDirIndex error: " + (e?.message ?? e));
  }
}

/**
 * Full rebuild: scan all wiki subdirectories and rewrite every index.md.
 * Handles deletions and renames missed by incremental appends.
 * Call during the bulk pipeline (before_agent_start) after auto-weave.
 */
export async function rebuildAllIndexes(): Promise<void> {
  const wikiDir = path.join(VAULT, "wiki");
  let dirEntries: string[];
  try {
    dirEntries = await fs.promises.readdir(wikiDir);
  } catch {
    return;
  }

  await Promise.all(dirEntries.map(async (entry) => {
    const fullDir = path.join(wikiDir, entry);
    try {
      if (!(await fs.promises.stat(fullDir)).isDirectory()) return;
    } catch {
      return;
    }
    if (EXCLUDED_DIRS.has(entry)) return;

    let files: string[];
    try {
      const all = await fs.promises.readdir(fullDir);
      files = all.filter((f) => f.endsWith(".md") && f !== "index.md").sort();
    } catch {
      return;
    }

    if (files.length === 0) {
      try { await fs.promises.unlink(path.join(fullDir, "index.md")); } catch { /* ok */ }
      return;
    }

    const pageEntries = await Promise.all(files.map(async (f) => {
      try {
        const fullPath = path.join(fullDir, f);
        const content = await fs.promises.readFile(fullPath, "utf-8");
        const { title, summary } = parsePageMeta(content);
        return `* [${title}](wiki/${entry}/${f}) — ${summary}`;
      } catch {
        return `* ${f.replace(/\.md$/, "")} — 读取失败`;
      }
    }));

    const lines = [
      `# ${entry}`,
      "",
      "Agent 逐级浏览入口。由管线自动维护。",
      "",
      ...pageEntries,
      "",
    ];
    writeFile(`wiki/${entry}/index.md`, lines.join("\n"));
  }));
}

/**
 * Rebuild root wiki/index.md — top-level navigation listing all categories
 * and recent compilations. OKF-style progressive disclosure entry point.
 * No frontmatter (per OKF §6).
 */
export async function rebuildRootIndex(): Promise<void> {
  const wikiDir = path.join(VAULT, "wiki");
  let dirEntries: string[];
  try {
    dirEntries = await fs.promises.readdir(wikiDir);
  } catch {
    return;
  }

  const lines: string[] = [
    "# LLM-Wiki 知识库导航",
    "",
    "Agent 自主浏览入口。通过以下分类逐级浏览。",
    "",
    "> 此页面由管线自动维护。",
    "",
    "## 分类",
    "",
  ];

  // Collect all wiki pages for "最近编译" section
  const allPages: { path: string; mtime: Date; title: string }[] = [];

  const dirTasks = dirEntries.map(async (entry) => {
    const fullDir = path.join(wikiDir, entry);
    try {
      if (!(await fs.promises.stat(fullDir)).isDirectory()) return null;
    } catch {
      return null;
    }
    if (EXCLUDED_DIRS.has(entry)) return null;

    let files: string[];
    try {
      const all = await fs.promises.readdir(fullDir);
      files = all.filter((f) => f.endsWith(".md") && f !== "index.md");
    } catch {
      return null;
    }

    if (files.length === 0) return null;

    // Collect page metadata for recent list
    const pageResults = await Promise.all(files.map(async (f) => {
      const fullPath = path.join(fullDir, f);
      try {
        const content = await fs.promises.readFile(fullPath, "utf-8");
        const { title } = parsePageMeta(content);
        return {
          path: `wiki/${entry}/${f}`,
          mtime: (await fs.promises.stat(fullPath)).mtime,
          title,
        };
      } catch {
        return {
          path: `wiki/${entry}/${f}`,
          mtime: new Date(0),
          title: f.replace(/\.md$/, ""),
        };
      }
    }));

    return { entry, count: files.length, pages: pageResults };
  });

  const dirResults = (await Promise.all(dirTasks)).filter(Boolean);

  // Build category listing + collect all pages
  for (const r of dirResults) {
    const indexPath = `wiki/${r!.entry}/index.md`;
    lines.push(`* [${r!.entry}](${indexPath}) — ${r!.count} 条`);
    allPages.push(...r!.pages);
  }

  // "最近编译" — last 10 by mtime
  allPages.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  const recent = allPages.slice(0, 10);

  if (recent.length > 0) {
    lines.push("", "## 最近编译", "");
    for (const r of recent) {
      const dateStr = r.mtime.toISOString().split("T")[0];
      lines.push(`* [${r.title}](${r.path}) — ${dateStr}`);
    }
  }

  lines.push(""); // trailing newline
  writeFile("wiki/index.md", lines.join("\n"));
}
