/**
 * Phase 0.2: Merge duplicate fork sessions
 *
 * Identifies sessions that are clearly subagent fork duplicates (same title, same goals).
 * Keeps the most complete one, marks others as `skipped: fork-merged`.
 *
 * Groups:
 *   - By same title (case-insensitive)
 *   - For each group, picks the best candidate (most content, most messages)
 *   - Marks others as compiled:true + skipped:fork-merged + merged_into:<candidate>
 *
 * Usage: npx tsx scripts/merge-fork-sessions.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";

const VAULT = "/mnt/d/DB/Obsidian/LLM-Wiki";
const REPORT_PATH = "/tmp/llm-wiki-fork-merge-report.json";

function parseFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fm: Record<string, unknown> = {};
  for (const line of match[1].split("\n")) {
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    let value: unknown = line.slice(sep + 1).trim();
    if (typeof value === "string" && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    else if (value === "true") value = true;
    else if (value === "false") value = false;
    else if (/^\d+$/.test(String(value))) value = Number(value);
    fm[key] = value;
  }
  return fm;
}

function setFrontmatterField(md: string, key: string, value: unknown): string {
  let yamlVal: string;
  if (typeof value === "boolean") yamlVal = value ? "true" : "false";
  else if (typeof value === "number") yamlVal = String(value);
  else if (typeof value === "string" && /[:\[\]{}]/.test(value)) yamlVal = `"${value.replace(/"/g, '\\"')}"`;
  else yamlVal = String(value);

  const fmMatch = md.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return `---\n${key}: ${yamlVal}\n---\n\n${md}`;

  const fm = fmMatch[1];
  const lines = fm.split("\n");
  const keyIdx = lines.findIndex((l) => l.trim().startsWith(key + ":"));
  if (keyIdx >= 0) {
    lines[keyIdx] = `${key}: ${yamlVal}`;
  } else {
    lines.push(`${key}: ${yamlVal}`);
  }
  return md.replace(fmMatch[0], `---\n${lines.join("\n")}\n---`);
}

function getBody(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
  return match ? match[1].trim() : content.trim();
}

interface SessionInfo {
  relPath: string;
  fullPath: string;
  title: string;
  body: string;
  fileSize: number;
  userCount: number;
}

function main() {
  const base = path.join(VAULT, "raw/sessions");
  const allSessions: SessionInfo[] = [];

  // Collect all sessions
  for (const proj of fs.readdirSync(base).filter((d) => {
    try { return fs.statSync(path.join(base, d)).isDirectory(); } catch { return false; }
  })) {
    const projDir = path.join(base, proj);
    for (const f of fs.readdirSync(projDir).filter((f) => f.endsWith(".md"))) {
      const fullPath = path.join(projDir, f);
      const content = fs.readFileSync(fullPath, "utf-8");
      const fm = parseFrontmatter(content);
      const body = getBody(content);

      // Skip already-compiled sessions (but not the ones we just marked compiled:false in phase 0.1)
      if (fm.compiled === true || fm.compiled === "true") {
        if (fm.skipped === "duplicate" || fm.skipped === "trivial" || fm.skipped === "fork-merged") continue;
        // Already compiled non-skipped sessions are real — skip
        continue;
      }

      const title = String(fm.title ?? path.basename(f, ".md")).trim();
      // Count user messages in body
      const userCount = (body.match(/^(?:### 🎯|-\s)/m) ? 1 : 0);
      const fileSize = content.length;

      allSessions.push({
        relPath: `raw/sessions/${proj}/${f}`,
        fullPath,
        title,
        body,
        fileSize,
        userCount,
      });
    }
  }

  // Group by normalized title
  const groups = new Map<string, SessionInfo[]>();
  for (const s of allSessions) {
    const key = s.title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, "").trim();
    if (!key) continue;
    const existing = groups.get(key) ?? [];
    existing.push(s);
    groups.set(key, existing);
  }

  // Filter to groups with duplicates (≥2 sessions with same title)
  const duplicateGroups = [...groups.entries()]
    .filter(([, sessions]) => sessions.length >= 2)
    .sort((a, b) => b[1].length - a[1].length);

  console.log(`Found ${duplicateGroups.length} groups with duplicate content:\n`);

  const report: {
    group: { title: string; count: number; kept: string; merged: string[] };
  }[] = [];
  let totalMerged = 0;

  for (const [key, sessions] of duplicateGroups) {
    // Sort by content quality: most user messages, largest file, most recent
    sessions.sort((a, b) => {
      // Prefer sessions with explicit goal section
      const aHasGoal = a.body.includes("### 🎯") ? 1 : 0;
      const bHasGoal = b.body.includes("### 🎯") ? 1 : 0;
      if (aHasGoal !== bHasGoal) return bHasGoal - aHasGoal;
      // Prefer larger content (more detailed)
      return b.fileSize - a.fileSize;
    });

    const best = sessions[0];
    const toMerge = sessions.slice(1);
    const mergeNames: string[] = [];

    for (const s of toMerge) {
      const content = fs.readFileSync(s.fullPath, "utf-8");
      let updated = setFrontmatterField(content, "compiled", true);
      updated = setFrontmatterField(updated, "weaved", true);
      updated = setFrontmatterField(updated, "linted", true);
      updated = setFrontmatterField(updated, "skipped", "fork-merged");
      updated = setFrontmatterField(updated, "merged_into", best.relPath);
      fs.writeFileSync(s.fullPath, updated, "utf-8");
      mergeNames.push(s.relPath);
      totalMerged++;
    }

    console.log(`  "${sessions[0].title.slice(0, 60)}"`);
    console.log(`    → kept: ${best.relPath}`);
    console.log(`    → merged ${toMerge.length} duplicates`);
    for (const m of toMerge) {
      console.log(`      ✗ ${m.relPath}`);
    }
    console.log();

    report.push({
      group: {
        title: sessions[0].title,
        count: sessions.length,
        kept: best.relPath,
        merged: mergeNames,
      },
    });
  }

  // Save report
  const reportData = {
    totalGroups: duplicateGroups.length,
    totalMerged,
    groups: report,
    timestamp: new Date().toISOString(),
  };
  fs.writeFileSync(REPORT_PATH, JSON.stringify(reportData, null, 2));

  console.log(`=== Summary ===`);
  console.log(`Groups with duplicates: ${duplicateGroups.length}`);
  console.log(`Sessions merged: ${totalMerged}`);
  console.log(`Report: ${REPORT_PATH}`);
}

main();
