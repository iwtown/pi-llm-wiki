/**
 * P3: Migrate pipeline state from 3 booleans → single status field
 *
 * Reads all raw session files, computes status from compiled/weaved/linted,
 * writes the new `status` field while keeping old fields for backward compat.
 *
 * Usage: npx tsx scripts/migrate-pipeline-status.ts [--dry-run] [--backup]
 */

import * as fs from "node:fs";
import * as path from "node:path";

const VAULT = "/mnt/d/DB/Obsidian/LLM-Wiki";
const REPORT_PATH = "/tmp/pipeline-migration-report.json";

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

const DRY_RUN = process.argv.includes("--dry-run");
const BACKUP = process.argv.includes("--backup");

if (DRY_RUN) console.log("DRY RUN — no files will be modified");
if (BACKUP) console.log("Backup enabled — .bak files will be created");
console.log("");

function main() {
  const base = path.join(VAULT, "raw/sessions");
  const projects = fs.readdirSync(base).filter((d) => {
    try { return fs.statSync(path.join(base, d)).isDirectory(); } catch { return false; }
  });

  const counts: Record<string, number> = {
    pending: 0, compiled: 0, woven: 0, done: 0, skipped: 0,
    noChange: 0, error: 0, alreadyMigrated: 0,
  };
  const details: Array<{ file: string; oldStatus: string; newStatus: string }> = [];

  for (const proj of projects) {
    const projDir = path.join(base, proj);
    for (const f of fs.readdirSync(projDir).filter((f) => f.endsWith(".md"))) {
      const fullPath = path.join(projDir, f);
      try {
        const content = fs.readFileSync(fullPath, "utf-8");
        const fm = parseFrontmatter(content);
        const relPath = `raw/sessions/${proj}/${f}`;

        // If already has status field, skip
        if (fm.status && typeof fm.status === "string" && ["pending", "compiled", "woven", "done", "skipped"].includes(fm.status as string)) {
          counts.alreadyMigrated++;
          continue;
        }

        // Read old booleans
        const compiled = fm.compiled === true || fm.compiled === "true";
        const weaved = fm.weaved === true || fm.weaved === "true";
        const linted = fm.linted === true || fm.linted === "true";
        const skipped = fm.skipped === "fork-merged" || fm.skipped === "trivial" || fm.skipped === "duplicate"
          || fm.trivial === true || fm.trivial === "true";

        // Compute new status
        let newStatus: string;
        let oldStatus = `compiled=${compiled} weaved=${weaved} linted=${linted} skipped=${skipped}`;

        if (skipped) {
          newStatus = "skipped";
        } else if (compiled && weaved && linted) {
          newStatus = "done";
        } else if (compiled && weaved) {
          newStatus = "woven";
        } else if (compiled) {
          newStatus = "compiled";
        } else {
          newStatus = "pending";
        }

        // Write new status field
        let updated = setFrontmatterField(content, "status", newStatus);
        // Also set status on skip reason sessions for consistency
        if (skipped && fm.skipped) {
          updated = setFrontmatterField(updated, "status", "skipped");
        }

        if (DRY_RUN) {
          console.log(`  would update ${relPath}: ${oldStatus} → ${newStatus}`);
        } else {
          // Backup if requested
          if (BACKUP) {
            const bakPath = fullPath + ".bak";
            if (!fs.existsSync(bakPath)) {
              fs.copyFileSync(fullPath, bakPath);
            }
          }
          fs.writeFileSync(fullPath, updated, "utf-8");
        }
        counts[newStatus] = (counts[newStatus] || 0) + 1;
        details.push({ file: relPath, oldStatus, newStatus });
      } catch (e: any) {
        counts.error++;
        console.error(`Error processing ${proj}/${f}: ${e.message}`);
      }
    }
  }

  // Save report
  const report = {
    timestamp: new Date().toISOString(),
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    counts,
    details,
  };
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

  console.log(`=== Migration ${DRY_RUN ? "(DRY RUN)" : "Complete"} ===`);
  console.log(`  done: ${counts.done}`);
  console.log(`  woven: ${counts.woven}`);
  console.log(`  compiled: ${counts.compiled}`);
  console.log(`  pending: ${counts.pending}`);
  console.log(`  skipped: ${counts.skipped}`);
  console.log(`  already had status: ${counts.alreadyMigrated}`);
  console.log(`  errors: ${counts.error}`);
  console.log(`Report: ${REPORT_PATH}`);
}

main();
