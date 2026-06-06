/**
 * pi-llm-wiki — Content analyzer for knowledge evolution.
 * Cross-page text analysis: similarity, upgrade detection, contradiction.
 * Reads vault filesystem directly — API-independent.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { LLM_WIKI } from "../config";

const VAULT = LLM_WIKI.vault;

export interface WikiPage {
  /** Relative vault path: wiki/概念/foo.md */
  path: string;
  title: string;
  project?: string;
  /** Body text after frontmatter */
  body: string;
  /** Full content */
  content: string;
}

// ---- Filesystem helpers ----

function safeReadDir(dir: string): string[] {
  try { return fs.readdirSync(dir); } catch { return []; }
}

function safeReadFile(filePath: string): string {
  try { return fs.readFileSync(filePath, "utf-8"); } catch { return ""; }
}

function parseFrontmatter(md: string): Record<string, string> {
  const match = md.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^([\w-]+):\s*"?(.+?)"?\s*$/);
    if (kv) result[kv[1]] = kv[2];
  }
  return result;
}

// ---- Wiki page collection ----

/** Collect all wiki pages from the vault */
export function collectWikiPages(): WikiPage[] {
  const pages: WikiPage[] = [];
  const wikiDir = path.join(VAULT, "wiki");

  function walk(dir: string) {
    for (const entry of safeReadDir(dir)) {
      const full = path.join(dir, entry);
      if (fs.statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith(".md")) {
        const content = safeReadFile(full);
        const fm = parseFrontmatter(content);
        const relPath = path.relative(VAULT, full);
        const body = content.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
        pages.push({
          path: relPath,
          title: fm.title ?? entry.replace(".md", ""),
          project: fm.project,
          body,
          content,
        });
      }
    }
  }

  walk(wikiDir);
  return pages;
}

// ---- Text similarity ----

/** Normalize text for comparison: lowercase, strip punctuation, tokenize */
function normalizeText(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fff\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 2)
  );
}

/** Jaccard similarity between two texts (0-1) */
export function textSimilarity(a: string, b: string): number {
  const setA = normalizeText(a);
  const setB = normalizeText(b);
  if (setA.size === 0 && setB.size === 0) return 0;
  const intersection = new Set([...setA].filter((w) => setB.has(w)));
  const union = new Set([...setA, ...setB]);
  return intersection.size / union.size;
}

// ---- Knowledge upgrade detection (P4.1) ----

export interface UpgradeSuggestion {
  insight: string;
  projectCount: number;
  projects: string[];
  matchedPages: string[];
  suggestedTarget: "概念" | "发现";
}

/** Check if any insights from a project session appear in ≥2 other projects' wiki pages */
export function detectKnowledgeUpgrade(
  insights: string[],
  currentProject: string,
  allPages: WikiPage[],
): UpgradeSuggestion[] {
  const suggestions: UpgradeSuggestion[] = [];

  for (const insight of insights) {
    const key = insight.slice(0, 60); // use first 60 chars as search key
    const projects = new Set<string>();
    const matchedPages: string[] = [];

    for (const page of allPages) {
      if (!page.project || page.project === currentProject) continue;
      const similarity = textSimilarity(key, page.body.slice(0, 500));
      if (similarity > 0.15) {
        projects.add(page.project!);
        if (matchedPages.length < 3) matchedPages.push(page.path);
      }
    }

    if (projects.size >= 2) {
      const allProjects = [currentProject, ...projects];
      suggestions.push({
        insight: key,
        projectCount: allProjects.length,
        projects: [...new Set(allProjects)],
        matchedPages,
        suggestedTarget: projects.size >= 3 ? "概念" : "发现",
      });
    }
  }

  return suggestions;
}

// ---- Contradiction detection (P4.2) ----

export interface Contradiction {
  title: string;
  pages: string[];
  reason: string;
}

/** Find pages with similar titles (potential contradictions) */
export function detectContradictions(allPages: WikiPage[]): Contradiction[] {
  const contradictions: Contradiction[] = [];
  const titleMap = new Map<string, string[]>();

  for (const page of allPages) {
    // Normalize title: lowercase, remove punctuation, strip common suffixes
    const key = page.title
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fff]/g, "")
      .replace(/(修复|方案|指南|说明|教程|笔记|v\d+)$/g, "")
      .trim();
    if (!key) continue;

    const existing = titleMap.get(key) ?? [];
    existing.push(page.path);
    titleMap.set(key, existing);
  }

  for (const [key, pages] of titleMap) {
    if (pages.length < 2) continue;

    // Check if these are in different wiki categories (not same page in different dirs)
    const dirs = new Set(pages.map((p) => p.split("/")[1]));
    if (dirs.size < 2) continue;

    contradictions.push({
      title: key,
      pages,
      reason: `同一主题 "${key}" 在 ${dirs.size} 个类别中存在 ${pages.length} 个版本，可能存在矛盾`,
    });
  }

  return contradictions;
}

// ---- Duplicate content detection (P4.3) ----

export interface DuplicateGroup {
  pageA: string;
  pageB: string;
  similarity: number;
}

/** Find pairs of wiki pages with high content similarity (>70%) */
export function detectDuplicates(allPages: WikiPage[], threshold = 0.7): DuplicateGroup[] {
  const duplicates: DuplicateGroup[] = [];

  for (let i = 0; i < allPages.length; i++) {
    for (let j = i + 1; j < allPages.length; j++) {
      const a = allPages[i];
      const b = allPages[j];
      // Quick filter: skip if length differs too much
      if (Math.abs(a.body.length - b.body.length) > a.body.length * 0.5) continue;

      const sim = textSimilarity(
        a.body.slice(0, 1000),
        b.body.slice(0, 1000)
      );

      if (sim >= threshold) {
        duplicates.push({ pageA: a.path, pageB: b.path, similarity: sim });
      }
    }
  }

  duplicates.sort((a, b) => b.similarity - a.similarity);
  return duplicates.slice(0, 10); // top 10
}
