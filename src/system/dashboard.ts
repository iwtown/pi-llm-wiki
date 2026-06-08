/**
 * pi-llm-wiki — Dashboard generator.
 * Reads the vault filesystem to compute health stats and writes wiki/仪表盘.md.
 * Runs via before_agent_start hook — API-independent by design.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { LLM_WIKI, PATHS } from "../config";
import { parseFrontmatter } from "./parse";

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

/** Read agent_end success/failure counts from structured log */
function agentEndStats(): { ok: number; fail: number; lastOk: string; lastFail: string } {
  const logPath = path.join(process.env.HOME ?? "/home", ".pi/agent/pi-llm-wiki.log");
  let ok = 0, fail = 0, lastOk = "", lastFail = "";
  try {
    const lines = safeReadFile(logPath).split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.event === "auto_ingest_ok") { ok++; lastOk = entry.ts?.slice(0, 19) ?? ""; }
        if (entry.event === "auto_ingest_fail") { fail++; lastFail = entry.ts?.slice(0, 19) ?? ""; }
      } catch { continue; }
    }
  } catch { /* no log file yet */ }
  return { ok, fail, lastOk, lastFail };
}

export function generateDashboard(): string {
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const { projects, global } = collectRawStats();
  const { score, grade } = healthScore(global);
  const ops = recentOps(8);
  const wikiCounts = wikiPageCounts();
  const ae = agentEndStats();

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
    "## 🤖 Agent End 自动摄入",
    "",
    `| 指标 | 值 |`,
    `|------|------|`,
    `| ✅ 成功 | ${ae.ok} |`,
    `| ❌ 失败 | ${ae.fail} |`,
    `| 📈 成功率 | ${ae.ok + ae.fail > 0 ? Math.round(ae.ok / (ae.ok + ae.fail) * 100) : "N/A"}% |`,
    ae.lastOk ? `| 最近成功 | ${ae.lastOk} |` : "",
    ae.lastFail ? `| 最近失败 | ${ae.lastFail} |` : "",
  ];

  // Project distribution
  lines.push("", "## 📂 项目分布", "");
  lines.push("| 项目 | Session | 编译率 |", "|------|---------|--------|");
  for (const p of projects) {
    lines.push(`| ${p.name} | ${p.total} | ${p.compiledRate}% |`);
  }

  // Recent operations
  lines.push("", "## 📝 最近操作", "");
  if (ops.length > 0) {
    for (const o of ops) lines.push(`- ${o.replace(/^##\s*/, "")}`);
  } else {
    lines.push("- 暂无记录");
  }

  // Wiki page distribution
  lines.push("", "## 📚 知识库分布", "");
  const sortedWiki = Object.entries(wikiCounts).sort((a, b) => b[1] - a[1]);
  lines.push("| 类别 | 页面数 |", "|------|--------|");
  for (const [cat, count] of sortedWiki) {
    lines.push(`| ${cat} | ${count} |`);
  }

  return lines.join("\n");
}
