/**
 * pi-llm-wiki — Flow audit generator.
 * Inspects the 5-stage pipeline health and writes wiki/流程巡检.md.
 * C1: ingest → C2: compile → C3: weave → C4: lint → C5: aggregate
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { LLM_WIKI, PATHS } from "../config";

const VAULT = LLM_WIKI.vault;

// ---- Helpers ----

function safeReadDir(dir: string): string[] {
  try { return fs.readdirSync(dir); } catch { return []; }
}

function safeReadFile(filePath: string): string {
  try { return fs.readFileSync(filePath, "utf-8"); } catch { return ""; }
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

interface RawFile {
  path: string;    // relative vault path
  name: string;
  compiled: boolean;
  weaved: boolean;
  linted: boolean;
  content: string;
  size: number;
}

function collectRawFiles(): RawFile[] {
  const files: RawFile[] = [];
  const rawDir = path.join(VAULT, PATHS.rawSessions);

  function walk(dir: string, prefix: string) {
    for (const entry of safeReadDir(dir)) {
      const full = path.join(dir, entry);
      if (fs.statSync(full).isDirectory()) {
        walk(full, `${prefix}${entry}/`);
      } else if (entry.endsWith(".md")) {
        const content = safeReadFile(full);
        const fm = parseFrontmatter(content);
        files.push({
          path: `${prefix}${entry}`,
          name: entry,
          compiled: fm.compiled === true,
          weaved: fm.weaved === true,
          linted: fm.linted === true,
          content,
          size: content.length,
        });
      }
    }
  }

  walk(rawDir, "");
  return files;
}

function statusIcon(ok: boolean): string {
  return ok ? "✅" : "❌";
}

function rateStr(ok: number, total: number): string {
  if (total === 0) return "N/A";
  return `${Math.round((ok / total) * 100)}% (${ok}/${total})`;
}

// ---- Stage checks ----

interface StageResult {
  stage: string;
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
  issues: string[];
}

/** C1: Ingest completeness — detect empty shells or sessions missing key sections */
function checkC1(files: RawFile[]): StageResult {
  const empty: string[] = [];
  const missingGoals: string[] = [];

  for (const f of files) {
    if (f.size < 200) {
      empty.push(f.name);
    }
    const hasGoals = /🎯\s*目标|## 🎯/.test(f.content);
    if (!hasGoals) {
      missingGoals.push(f.name);
    }
  }

  const issues: string[] = [];
  if (empty.length > 0) issues.push(`${empty.length} 个空壳/超短 session`);
  if (missingGoals.length > 0) issues.push(`${missingGoals.length} 个缺少🎯目标`);

  return {
    stage: "C1",
    name: "摄入完整性",
    status: empty.length > files.length * 0.3 ? "fail" : empty.length > 0 ? "warn" : "pass",
    detail: issues.length > 0 ? issues.join("；") : "全部通过",
    issues: empty.length > 0 ? empty.slice(0, 5).map((n) => `空壳: ${n}`) : [],
  };
}

/** C2: Compile coverage — uncompiled rate */
function checkC2(files: RawFile[]): StageResult {
  const uncompiled = files.filter((f) => !f.compiled);
  const rate = files.length > 0 ? Math.round((files.filter((f) => f.compiled).length / files.length) * 100) : 100;

  return {
    stage: "C2",
    name: "编译覆盖",
    status: rate < 40 ? "fail" : rate < 70 ? "warn" : "pass",
    detail: rateStr(files.filter((f) => f.compiled).length, files.length),
    issues: uncompiled.length > 0
      ? [`${uncompiled.length} 个待编译 session`]
      : [],
  };
}

/** C3: Weave coverage — unweaved rate among compiled */
function checkC3(files: RawFile[]): StageResult {
  const compiled = files.filter((f) => f.compiled);
  const unweaved = compiled.filter((f) => !f.weaved);
  const rate = compiled.length > 0 ? Math.round(((compiled.length - unweaved.length) / compiled.length) * 100) : 0;

  return {
    stage: "C3",
    name: "织入覆盖",
    status: compiled.length > 0 && rate < 30 ? "fail" : rate < 80 ? "warn" : "pass",
    detail: compiled.length > 0 ? rateStr(compiled.length - unweaved.length, compiled.length) : "无已编译的 session",
    issues: unweaved.length > 0
      ? [`${unweaved.length} 个已编译但未织入`]
      : [],
  };
}

/** C4: Lint health — orphan/stale/broken wiki pages */
function checkC4(): StageResult {
  const wikiDir = path.join(VAULT, "wiki");
  const issues: string[] = [];
  const now = Date.now();
  const STALE_MS = 90 * 24 * 60 * 60 * 1000;

  let orphans = 0;
  let stale = 0;

  function walk(dir: string) {
    for (const entry of safeReadDir(dir)) {
      const full = path.join(dir, entry);
      if (fs.statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith(".md")) {
        const content = safeReadFile(full);
        const fm = parseFrontmatter(content);

        // Check updated date
        const updated = fm.updated as string;
        if (updated) {
          const ts = new Date(updated).getTime();
          if (ts && now - ts > STALE_MS) {
            stale++;
            if (stale <= 3) issues.push(`过期: ${entry}`);
          }
        }

        // Check for wikilinks (simplified)
        const linkCount = (content.match(/\[\[.+\]\]/g) || []).length;
        if (linkCount === 0 && !entry.startsWith("仪表盘") && !entry.startsWith("图谱") && !entry.startsWith("流程巡检") && !entry.startsWith("问题追踪") && !entry.startsWith("hot") && !entry.startsWith("索引")) {
          orphans++;
          if (orphans <= 3) issues.push(`孤立: ${entry}`);
        }
      }
    }
  }

  walk(wikiDir);

  const totalIssues = orphans + stale;
  return {
    stage: "C4",
    name: "知识库健康",
    status: totalIssues > 10 ? "fail" : totalIssues > 3 ? "warn" : "pass",
    detail: `${orphans} 孤立节点, ${stale} 过期页面`,
    issues: issues.slice(0, 5),
  };
}

/** C5: Aggregate readiness — pending compilation queue */
function checkC5(files: RawFile[]): StageResult {
  const uncompiled = files.filter((f) => !f.compiled);
  const threshold = 5; // compile trigger threshold

  return {
    stage: "C5",
    name: "编译准备",
    status: uncompiled.length >= threshold * 2 ? "fail" : uncompiled.length >= threshold ? "warn" : "pass",
    detail: `待编译队列: ${uncompiled.length} (阈值: ${threshold})`,
    issues: uncompiled.length >= threshold
      ? [`超过编译阈值 (${threshold})，建议执行 obs_compile`]
      : [],
  };
}

// ---- Main ----

export function generateAudit(): string {
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const files = collectRawFiles();

  const stages = [
    checkC1(files),
    checkC2(files),
    checkC3(files),
    checkC4(),
    checkC5(files),
  ];

  const passCount = stages.filter((s) => s.status === "pass").length;
  const warnCount = stages.filter((s) => s.status === "warn").length;
  const failCount = stages.filter((s) => s.status === "fail").length;

  const summaryIcon = failCount > 0 ? "🔴" : warnCount > 0 ? "🟡" : "🟢";
  const summaryText = failCount > 0
    ? `${failCount} 个阶段告警`
    : warnCount > 0
    ? `${warnCount} 个阶段需要注意`
    : "全管线健康";

  const lines: string[] = [
    "---",
    "title: 流程巡检",
    "kind: system",
    `updated: "${now}"`,
    "---",
    "",
    "# 🔍 LLM-Wiki 流程巡检",
    "",
    `> 自动生成 — ${now}`,
    "",
    "## 📊 总览",
    "",
    `**${summaryIcon} ${summaryText}** (${passCount}✅ ${warnCount}🟡 ${failCount}🔴)`,
    "",
    "## 🔬 逐阶段检查",
    "",
  ];

  for (const s of stages) {
    const icon = s.status === "pass" ? "✅" : s.status === "warn" ? "🟡" : "🔴";
    lines.push(`### ${icon} ${s.stage} — ${s.name}`);
    lines.push("");
    lines.push(`**${s.detail}**`);
    lines.push("");
    if (s.issues.length > 0) {
      for (const issue of s.issues) {
        lines.push(`- ⚠️ ${issue}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}
