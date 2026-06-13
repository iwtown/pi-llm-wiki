/**
 * pi-llm-wiki — Pipeline runner.
 * Processes un-ingested/un-compiled raw sessions through the complete pipeline:
 *   compile → weave → lint
 *
 * Usage:
 *   npx tsx scripts/run-pipeline.ts                # default: process pending sessions
 *   npx tsx scripts/run-pipeline.ts --all           # process ALL pending + already-ingested
 *   npx tsx scripts/run-pipeline.ts --dry-run       # show what would be processed
 *   npx tsx scripts/run-pipeline.ts --force <path>  # force-compile a specific raw session
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { detectProject } from "../src/project";
import { compile } from "../src/tools/compile";
import { weave } from "../src/tools/weave";
import { lint } from "../src/tools/lint";
import { LLM_WIKI, PATHS } from "../src/config";

const VAULT = LLM_WIKI.vault;
const RAW_DIR = path.join(VAULT, PATHS.rawSessions);
const CWD = process.env.PIPELINE_CWD || process.cwd();

interface FakeContext {
  cwd: string;
  sessionManager?: undefined;
}

const ctx: FakeContext = { cwd: CWD };

// ─── Helpers ───

function isPending(rawPath: string): { pending: boolean; score: number; reason?: string } {
  try {
    const content = fs.readFileSync(rawPath, "utf-8");
    const fm = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fm) return { pending: false, score: 0, reason: "no frontmatter" };

    const fmText = fm[1];
    const compiled = fmText.match(/compiled:\s*(true|false|\d{4}[-\d]*)/);
    if (compiled && compiled[1] !== "false") {
      return { pending: false, score: 0, reason: `already compiled (${compiled[1]})` };
    }

    const scoreMatch = fmText.match(/session_score:\s*(\d+)/);
    const score = scoreMatch ? parseInt(scoreMatch[1], 10) : 0;

    if (score > 0 && score < 50) {
      return { pending: false, score, reason: `low quality (score=${score})` };
    }

    return { pending: true, score };
  } catch {
    return { pending: false, score: 0, reason: "unreadable" };
  }
}

function findRawSessions(projectDir?: string): { fsPath: string; vaultRel: string }[] {
  const searchDirs = projectDir
    ? [path.join(RAW_DIR, projectDir)]
    : fs.readdirSync(RAW_DIR).map((d) => path.join(RAW_DIR, d));

  const files: { fsPath: string; vaultRel: string }[] = [];
  for (const dir of searchDirs) {
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      const entries = fs.readdirSync(dir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => ({
          fsPath: path.join(dir, f),
          vaultRel: path.relative(VAULT, path.join(dir, f)),
        }));
      files.push(...entries);
    } catch {
      // skip
    }
  }
  return files;
}

// ─── Main ───

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const all = args.includes("--all");
  const forceIdx = args.indexOf("--force");
  const forceFile = forceIdx >= 0 ? args[forceIdx + 1] : null;

  if (forceFile) {
    console.log(`\n🔧 Force-compiling: ${forceFile}`);
    const result = await compile(forceFile, {}, ctx as any);
    if (result) {
      console.log(`   ✅ Compiled → ${result.wikiPath}`);
      if (result.dedupSuggestion) console.log(`   ℹ️  ${result.dedupSuggestion}`);
    } else {
      console.log(`   ❌ Compile failed`);
    }
    return;
  }

  // Find all raw sessions
  const allSessions = findRawSessions();
  console.log(`\n📂 Found ${allSessions.length} raw sessions total\n`);

  // Filter pending
  const pending = allSessions.filter(({ fsPath }) => {
    const { pending } = isPending(fsPath);
    return pending;
  });

  if (pending.length === 0) {
    console.log("✅ No pending sessions to compile. All caught up!");
    return;
  }

  console.log(`⏳ ${pending.length} sessions pending compilation:\n`);
  for (const { vaultRel, fsPath } of pending) {
    const { score } = isPending(fsPath);
    console.log(`   📄 ${vaultRel} (score: ${score})`);
  }

  if (dryRun) {
    console.log("\n🏁 Dry run — no changes made.");
    return;
  }

  // Process each pending session
  let compiled = 0;
  let deduped = 0;
  let errors = 0;

  for (const { vaultRel, fsPath } of pending) {
    const rawPath = vaultRel; // compile() expects vault-relative path
    try {
      console.log(`\n🔧 Compiling: ${vaultRel}...`);
      const result = await compile(rawPath, {}, ctx as any);

      if (!result) {
        console.log(`   ❌ compile() returned null`);
        errors++;
        continue;
      }

      if (result.wikiPath) {
        console.log(`   ✅ → ${result.wikiPath}`);
        if (result.dedupSuggestion) {
          console.log(`   ℹ️  ${result.dedupSuggestion}`);
          deduped++;
        } else {
          compiled++;
        }

        // Weave
        if (result.linkedTo && result.linkedTo.length > 0) {
          console.log(`   🔗 Weaving links: ${result.linkedTo.length} pages...`);
          const weaveResult = await weave(
            vaultRel,
            result.wikiPath,
            result.linkedTo,
            result.insights,
            ctx as any
          );
          console.log(`      Updated: ${weaveResult.updatedPages.length} pages`);
          if (weaveResult.errors.length > 0) {
            console.log(`      ⚠️  Weave errors: ${weaveResult.errors.length}`);
          }
        } else {
          console.log(`   🔗 No links to weave`);
        }
      } else {
        console.log(`   ℹ️  ${result.dedupSuggestion || "No wiki page created"}`);
        deduped++;
      }
    } catch (e: any) {
      console.log(`   ❌ Error: ${e.message}`);
      if (e.stack) console.log(`      ${e.stack.split("\n").slice(0, 3).join("\n      ")}`);
      errors++;
    }
  }

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log(`📊 Pipeline Summary:`);
  console.log(`   ✅ Compiled:   ${compiled}`);
  console.log(`   ⏭️  Deduped:    ${deduped}`);
  console.log(`   ❌ Errors:     ${errors}`);
  console.log(`   📦 Total:      ${pending.length}`);

  // Run lint
  if (compiled > 0 || all) {
    console.log(`\n🔍 Running lint check...`);
    try {
      const lintResult = await lint(ctx as any);
      console.log(`   Issues: ${lintResult.issues.length}`);
      const errors_ = lintResult.issues.filter((i: any) => i.severity === "error");
      const warnings = lintResult.issues.filter((i: any) => i.severity === "warning");
      console.log(`   🔴 Errors:   ${errors_.length}`);
      console.log(`   🟡 Warnings: ${warnings.length}`);
      if (warnings.length > 0) {
        for (const w of warnings.slice(0, 5)) {
          console.log(`      ⚠️  ${w.path}: ${w.message}`);
        }
      }
    } catch (e: any) {
      console.log(`   ❌ Lint failed: ${e.message}`);
    }
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
