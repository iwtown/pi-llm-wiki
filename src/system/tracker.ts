/**
 * pi-llm-wiki — Issue tracker generator.
 * Tracks pending compile queue and recently resolved items.
 * Writes wiki/问题追踪.md.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { LLM_WIKI, PATHS } from "../config";
import { parseFrontmatter } from "./parse";

const VAULT = LLM_WIKI.vault;

// ---- Helpers ----

function safeReadDir(dir: string): string[] {
  try { return fs.readdirSync(dir); } catch { return []; }
}

function safeReadFile(filePath: string): string {
  try { return fs.readFileSync(filePath, "utf-8"); } catch { return ""; }
}

interface TrackedSession {
  path: string;
  title: string;
  project: string;
  compiled: boolean;
  weaved: boolean;
  linted: boolean;
}

function collectTrackedSessions(): TrackedSession[] {
  const sessions: TrackedSession[] = [];
  const rawDir = path.join(VAULT, PATHS.rawSessions);

  for (const projDir of safeReadDir(rawDir)) {
    const projPath = path.join(rawDir, projDir);
    if (!fs.statSync(projPath).isDirectory()) continue;

    for (const file of safeReadDir(projPath)) {
      if (!file.endsWith(".md")) continue;
      const content = safeReadFile(path.join(projPath, file));
      const fm = parseFrontmatter(content);
      sessions.push({
        path: `${PATHS.rawSessions}/${projDir}/${file}`,
        title: (fm.title as string) || file.replace(/\.md$/, ""),
        project: (fm.project as string) || projDir,
        compiled: fm.compiled === true,
        weaved: fm.weaved === true,
        linted: fm.linted === true,
      });
    }
  }

  return sessions;
}

export function generateTracker(): string {
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const sessions = collectTrackedSessions();

  const pendingCompile = sessions
    .filter((s) => !s.compiled)
    .sort((a, b) => a.path.localeCompare(b.path));

  const pendingWeave = sessions
    .filter((s) => s.compiled && !s.weaved)
    .sort((a, b) => a.path.localeCompare(b.path));

  const completed = sessions
    .filter((s) => s.compiled && s.weaved && s.linted)
    .sort((a, b) => b.path.localeCompare(a.path))
    .slice(0, 10);

  const lines: string[] = [
    "---",
    "title: 问题追踪",
    "kind: system",
    `updated: "${now}"`,
    "---",
    "",
    "# 📋 LLM-Wiki 问题追踪",
    "",
    `> 自动生成 — ${now}`,
    "",
    "## 🎯 Tasks 面板（Obsidian 中交互操作）",
    "",
    "### 待编译",
    "\`\`\`tasks",
    "not done",
    "path includes raw/sessions",
    "\`\`\`",
    "",
    "## 🔴 待编译",
    "",
  ];

  if (pendingCompile.length === 0) {
    lines.push("✅ 无待编译 session");
  } else {
    lines.push(`共 ${pendingCompile.length} 个待编译：`);
    lines.push("");
    lines.push("| 标题 | 项目 |");
    lines.push("|------|------|");
    for (const s of pendingCompile.slice(0, 20)) {
      lines.push(`| [[${s.path}\|${s.title}]] | ${s.project} |`);
    }
    if (pendingCompile.length > 20) {
      lines.push(`| ... | 还有 ${pendingCompile.length - 20} 个 |`);
    }
  }

  lines.push(
    "",
    "## 🟡 已编译待织入",
    "",
  );

  if (pendingWeave.length === 0) {
    lines.push("✅ 无待织入 session");
  } else {
    lines.push(`共 ${pendingWeave.length} 个：`);
    lines.push("");
    lines.push("| 标题 | 项目 |");
    lines.push("|------|------|");
    for (const s of pendingWeave.slice(0, 10)) {
      lines.push(`| [[${s.path}\|${s.title}]] | ${s.project} |`);
    }
  }

  lines.push(
    "",
    "## 🟢 最近完成（编译+织入+lint）",
    "",
  );

  if (completed.length === 0) {
    lines.push("暂无全链路完成的 session");
  } else {
    lines.push("| 标题 | 项目 |");
    lines.push("|------|------|");
    for (const s of completed) {
      lines.push(`| [[${s.path}\|${s.title}]] | ${s.project} |`);
    }
  }

  lines.push(
    "",
    "## 📊 统计",
    "",
    `| 指标 | 值 |`,
    `|------|------|`,
    `| 总 session | ${sessions.length} |`,
    `| 待编译 | ${pendingCompile.length} |`,
    `| 待织入 | ${pendingWeave.length} |`,
    `| 全链路完成 | ${completed.length} |`,
  );

  lines.push(
    "",
    "## 🎯 Tasks 面板（Obsidian 中交互操作）",
    "",
    "### 🔴 待编译",
    ...pendingCompile.map((s) => `- [ ] ${s.title} 📅 ${new Date().toISOString().split("T")[0]}`),
    "",
    "### 🟡 待织入",
    ...pendingWeave.map((s) => `- [ ] ${s.title} 📅 ${new Date().toISOString().split("T")[0]}`),
    "",
  );

  return lines.join("\n");
}
