/**
 * pi-llm-wiki — Dashboard generator.
 * Reads the vault filesystem to compute health stats and writes wiki/仪表盘.md.
 * Runs via before_agent_start hook — API-independent by design.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { LLM_WIKI, PATHS } from "../config";

const VAULT = LLM_WIKI.vault;

interface RawStats {
  total: number;
  compiled: number;
  weaved: number;
  linted: number;
}

interface PerProjectStats {
  name: string;
  total: number;
  compiled: number;
  compiledRate: number;
}

function parseFrontmatter(md: string): Record<string, boolean | string> {
  const match = md.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result: Record<string, boolean | string> = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (!kv) continue;
    const v = kv[2].trim();
    result[kv[1]] = v === "true" ? true : v === "false" ? false : v;
  }
  return result;
}

function safeReadDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function safeReadFile(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

/** Count raw sessions per project with compiled/weaved/linted stats */
function collectRawStats(): { projects: PerProjectStats[]; global: RawStats } {
  const projects: PerProjectStats[] = [];
  const global: RawStats = { total: 0, compiled: 0, weaved: 0, linted: 0 };
  const rawDir = path.join(VAULT, PATHS.rawSessions);

  for (const subdir of safeReadDir(rawDir)) {
    const subPath = path.join(rawDir, subdir);
    if (!fs.statSync(subPath).isDirectory()) continue;

    const files = safeReadDir(subPath).filter((f) => f.endsWith(".md"));
    if (files.length === 0) continue;

    let projCompiled = 0;
    for (const f of files) {
      const fm = parseFrontmatter(safeReadFile(path.join(subPath, f)));
      global.total++;
      if (fm.compiled === true) { global.compiled++; projCompiled++; }
      if (fm.weaved === true) global.weaved++;
      if (fm.linted === true) global.linted++;
    }

    projects.push({
      name: subdir,
      total: files.length,
      compiled: projCompiled,
      compiledRate: files.length > 0 ? Math.round((projCompiled / files.length) * 100) : 0,
    });
  }

  projects.sort((a, b) => b.total - a.total);
  return { projects, global };
}

/** Read recent ingest operations from log.md */
function recentOps(limit = 10): string[] {
  const logPath = path.join(VAULT, PATHS.log);
  const raw = safeReadFile(logPath);
  const lines = raw.split("\n").filter((l) => l.startsWith("## ["));
  return lines.slice(-limit).reverse();
}

/** Count wiki pages by category */
function wikiPageCounts(): Record<string, number> {
  const wikiDir = path.join(VAULT, "wiki");
  const counts: Record<string, number> = {};
  for (const dir of safeReadDir(wikiDir)) {
    const dirPath = path.join(wikiDir, dir);
    if (!fs.statSync(dirPath).isDirectory()) continue;
    const files = safeReadDir(dirPath).filter((f) => f.endsWith(".md"));
    if (files.length > 0) counts[dir] = files.length;
  }
  return counts;
}

function healthScore(stats: RawStats): { score: number; grade: string } {
  if (stats.total === 0) return { score: 100, grade: "N/A" };
  const compileRate = stats.compiled / stats.total;
  const weaveRate = stats.total > 0 ? stats.weaved / stats.total : 0;
  const lintRate = stats.total > 0 ? stats.linted / stats.total : 0;
  // Weighted: compile 50%, weave 30%, lint 20%
  const score = Math.round((compileRate * 0.5 + weaveRate * 0.3 + lintRate * 0.2) * 100);
  const grade = score >= 80 ? "🟢 健康" : score >= 50 ? "🟡 需要注意" : "🔴 严重";
  return { score, grade };
}

export function generateDashboard(): string {
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const { projects, global } = collectRawStats();
  const { score, grade } = healthScore(global);
  const ops = recentOps(8);
  const wikiCounts = wikiPageCounts();

  const compileRate = global.total > 0 ? Math.round((global.compiled / global.total) * 100) : 0;
  const weaveRate = global.total > 0 ? Math.round((global.weaved / global.total) * 100) : 0;

  const lines: string[] = [
    "---",
    "title: 仪表盘",
    "kind: system",
    `updated: "${now}"`,
    "---",
    "",
    `# 📊 LLM-Wiki 仪表盘`,
    "",
    `> 自动生成 — ${now}`,
    "",
    "## 🏥 健康评分",
    "",
    `| 指标 | 值 |`,
    `|------|------|`,
    `| **健康评分** | **${score}/100** — ${grade} |`,
    `| 编译率 | ${compileRate}% (${global.compiled}/${global.total}) |`,
    `| 织入率 | ${weaveRate}% (${global.weaved}/${global.total}) |`,
    `| Lint 率 | ${global.linted}/${global.total} |`,
    `| 知识页 | ${Object.values(wikiCounts).reduce((a, b) => a + b, 0)} 页 (${Object.keys(wikiCounts).length} 个类别) |`,
    "",
    "## 📂 项目分布",
    "",
    ...projects.map((p) =>
      `| ${p.name} | ${p.total} | ${p.compiledRate}% |`
    ),
  ];

  // Prepend header for project table
  lines.splice(lines.length - projects.length, 0,
    "| 项目 | Session | 编译率 |",
    "|------|---------|--------|"
  );

  lines.push(
    "",
    "## 📝 最近操作",
    "",
    ops.length > 0
      ? ops.map((o) => `- ${o.replace(/^##\s*/, "")}`).join("\n")
      : "- 暂无记录",
    "",
    "## 📚 知识库分布",
    "",
    ...Object.entries(wikiCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([cat, count]) => `| ${cat} | ${count} |`),
  );

  lines.splice(lines.length - Object.keys(wikiCounts).length, 0,
    "| 类别 | 页面数 |",
    "|------|--------|"
  );

  return lines.join("\n");
}
