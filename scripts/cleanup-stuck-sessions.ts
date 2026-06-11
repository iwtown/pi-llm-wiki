/**
 * Phase 0.1: Batch mark stuck / pending sessions
 *
 * Scans raw/sessions/ for files without `compiled:` field or with `compiled: false`.
 * For each:
 *   - If empty/trivial content (<200 chars) → mark compiled, skipped: "trivial"
 *   - If title/body matches existing wiki page → mark compiled, skipped: "duplicate"
 *   - If meaningful content with no title → add title + compiled: false (stays pending but visible)
 *   - Otherwise → add compiled: false (formalizes status for autoCompile)
 *
 * Usage: npx tsx scripts/cleanup-stuck-sessions.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";

const VAULT = "/mnt/d/DB/Obsidian/LLM-Wiki";
const REPORT_PATH = "/tmp/llm-wiki-cleanup-report.json";

// ── Helpers ──

function parseFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fm: Record<string, unknown> = {};
  for (const line of match[1].split("\n")) {
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    let value: unknown = line.slice(sep + 1).trim();
    // Unquote
    if (typeof value === "string" && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    } else if (value === "true") value = true;
    else if (value === "false") value = false;
    else if (/^\d+$/.test(String(value))) value = Number(value);
    fm[key] = value;
  }
  return fm;
}

function setFrontmatterField(md: string, key: string, value: unknown): string {
  // Determine YAML representation
  let yamlVal: string;
  if (typeof value === "boolean") yamlVal = value ? "true" : "false";
  else if (typeof value === "number") yamlVal = String(value);
  else if (typeof value === "string" && /[:\[\]{}]/.test(value)) yamlVal = `"${value.replace(/"/g, '\\"')}"`;
  else yamlVal = String(value);

  const fmMatch = md.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) {
    // No frontmatter — create one
    return `---\n${key}: ${yamlVal}\n---\n\n${md}`;
  }

  const fm = fmMatch[1];
  const lines = fm.split("\n");
  const keyIdx = lines.findIndex((l) => l.trim().startsWith(key + ":"));

  if (keyIdx >= 0) {
    lines[keyIdx] = `${key}: ${yamlVal}`;
  } else {
    // Append before the '---' closing
    lines.push(`${key}: ${yamlVal}`);
  }

  return md.replace(fmMatch[0], `---\n${lines.join("\n")}\n---`);
}

function getAllWikiTitles(): Set<string> {
  const titles = new Set<string>();
  const wikiDir = path.join(VAULT, "wiki");
  function walk(dir: string) {
    try {
      for (const e of fs.readdirSync(dir)) {
        const full = path.join(dir, e);
        if (fs.statSync(full).isDirectory()) walk(full);
        else if (e.endsWith(".md")) {
          const content = fs.readFileSync(full, "utf-8");
          const fm = parseFrontmatter(content);
          const title = fm.title;
          if (title && typeof title === "string") {
            titles.add(title.trim());
            titles.add(title.trim().toLowerCase());
          }
        }
      }
    } catch { /* skip */ }
  }
  walk(wikiDir);
  return titles;
}

function extractTitleFromBody(body: string): string {
  // Try to get title from `## 🎯 目标` section or first meaningful line
  const goalMatch = body.match(/### 🎯 目标\n\n([^\n]+)/);
  if (goalMatch) return goalMatch[1].trim().slice(0, 60);
  // First non-empty, non-header line
  const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const l of lines) {
    if (!l.startsWith("#") && !l.startsWith(">") && !l.startsWith("---")) {
      return l.slice(0, 60);
    }
  }
  return "";
}

function getBody(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
  return match ? match[1].trim() : content.trim();
}

// ── Main ──

interface Report {
  total: number;
  markedTrivial: string[];
  markedDuplicate: string[];
  formalizedStatus: string[];
  addedTitle: string[];
  errors: string[];
  timestamp: string;
}

function main() {
  const report: Report = {
    total: 0,
    markedTrivial: [],
    markedDuplicate: [],
    formalizedStatus: [],
    addedTitle: [],
    errors: [],
    timestamp: new Date().toISOString(),
  };

  const wikiTitles = getAllWikiTitles();
  console.log(`Wiki titles loaded: ${wikiTitles.size}`);

  const base = path.join(VAULT, "raw/sessions");
  const projectDirs = fs.readdirSync(base).filter((d) => {
    try { return fs.statSync(path.join(base, d)).isDirectory(); } catch { return false; }
  });

  for (const proj of projectDirs) {
    const projDir = path.join(base, proj);
    const files = fs.readdirSync(projDir).filter((f) => f.endsWith(".md"));

    for (const f of files) {
      const fullPath = path.join(projDir, f);
      const content = fs.readFileSync(fullPath, "utf-8");
      const fm = parseFrontmatter(content);
      const body = getBody(content);

      // Skip if already compiled
      if (fm.compiled === true || fm.compiled === "true") {
        continue;
      }

      report.total++;
      const relPath = `raw/sessions/${proj}/${f}`;

      // Check: trivial content (<200 chars including frontmatter)
      if (content.length < 200 && !fm.title) {
        let updated = setFrontmatterField(content, "compiled", true);
        updated = setFrontmatterField(updated, "skipped", "trivial");
        updated = setFrontmatterField(updated, "weaved", true);
        updated = setFrontmatterField(updated, "linted", true);
        fs.writeFileSync(fullPath, updated, "utf-8");
        report.markedTrivial.push(relPath);
        console.log(`  TRIVIAL: ${relPath}`);
        continue;
      }

      // Check: duplicate title exists in wiki
      const titleFromFm = fm.title ? String(fm.title).trim() : "";
      const titleFromBody = !titleFromFm ? extractTitleFromBody(body) : "";
      const sessionTitle = titleFromFm || titleFromBody || path.basename(f, ".md").slice(0, 50);

      if (titleFromFm && (wikiTitles.has(titleFromFm) || wikiTitles.has(titleFromFm.toLowerCase()))) {
        let updated = setFrontmatterField(content, "compiled", true);
        updated = setFrontmatterField(updated, "weaved", true);
        updated = setFrontmatterField(updated, "linted", true);
        updated = setFrontmatterField(updated, "skipped", "duplicate");
        fs.writeFileSync(fullPath, updated, "utf-8");
        report.markedDuplicate.push(relPath);
        console.log(`  DUPLICATE: ${relPath} (title: "${sessionTitle}")`);
        continue;
      }

      // Has meaningful content but no title → add title + compiled: false
      if (!fm.title && body.length > 200) {
        const newTitle = titleFromBody || path.basename(f, ".md").slice(0, 50);
        let updated = setFrontmatterField(content, "title", newTitle);
        updated = setFrontmatterField(updated, "compiled", false);
        fs.writeFileSync(fullPath, updated, "utf-8");
        report.addedTitle.push(relPath);
        console.log(`  ADDED TITLE: ${relPath} → "${newTitle}"`);
        continue;
      }

      // Formalize status: add compiled: false to make it visible
      let updated = setFrontmatterField(content, "compiled", false);
      fs.writeFileSync(fullPath, updated, "utf-8");
      report.formalizedStatus.push(relPath);
      console.log(`  FORMALIZED: ${relPath}`);
    }
  }

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`\n=== Done ===`);
  console.log(`Total processed: ${report.total}`);
  console.log(`Marked trivial: ${report.markedTrivial.length}`);
  console.log(`Marked duplicate: ${report.markedDuplicate.length}`);
  console.log(`Added title + pending: ${report.addedTitle.length}`);
  console.log(`Formalized pending: ${report.formalizedStatus.length}`);
  console.log(`Errors: ${report.errors.length}`);
  console.log(`\nReport saved to: ${REPORT_PATH}`);
}

main();
