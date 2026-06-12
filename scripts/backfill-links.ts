/**
 * pi-llm-wiki — Orphan backfill scanner.
 * Scans wiki/发现/ and wiki/决策/ for pages with outgoing [[wikilinks]] but no incoming links.
 * Outputs suggestions for manual backfill (read-only, no writes).
 *
 * Usage: npx tsx scripts/backfill-links.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";

const VAULT = "/mnt/d/DB/Obsidian/LLM-Wiki";

interface PageInfo {
  path: string;
  title: string;
  outboundLinks: string[];
}

function collectPages(): PageInfo[] {
  const pages: PageInfo[] = [];

  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".md")) {
        const content = fs.readFileSync(full, "utf-8");
        // Extract wikilinks
        const wikilinks = [...content.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]);
        // Extract title from frontmatter
        const titleMatch = content.match(/^title:\s*"?([^"\n]+)"?\s*$/m);
        const title = titleMatch?.[1] ?? entry.name.replace(/\.md$/, "");
        const rel = path.relative(VAULT, full).replace(/\\/g, "/");
        pages.push({ path: rel, title, outboundLinks: wikilinks });
      }
    }
  }

  walk(path.join(VAULT, "wiki"));
  return pages;
}

function buildIncomingIndex(pages: PageInfo[]): Map<string, string[]> {
  const incoming = new Map<string, string[]>();

  for (const p of pages) {
    for (const link of p.outboundLinks) {
      // Normalize: strip section anchors (#section), aliases (|alias), and .md extension
      const target = link.split("|")[0].split("#")[0].replace(/\.md$/i, "");
      const existing = incoming.get(target) ?? [];
      existing.push(p.path);
      incoming.set(target, existing);
    }
  }

  return incoming;
}

function main() {
  console.log("🔍 Scanning wiki pages for orphan analysis...\n");

  const pages = collectPages();
  const incoming = buildIncomingIndex(pages);

  console.log(`📊 Total pages: ${pages.length}`);
  console.log(`📊 Total incoming link entries: ${incoming.size}\n`);

  // Filter: only wiki/发现/ and wiki/决策/ pages that:
  // 1. Have outgoing wikilinks (have something to say)
  // 2. Have no incoming links (orphans)
  // 3. Are not dashboard/system/index pages
  const orphans = pages.filter((p) => {
    const isTargetType = p.path.startsWith("wiki/发现/") || p.path.startsWith("wiki/决策/");
    if (!isTargetType) return false;

    const hasOutboundLinks = p.outboundLinks.length > 0;
    if (!hasOutboundLinks) return false;

    const targetKey = p.path.replace(/\.md$/i, "");
    const incomingLinks = incoming.get(targetKey);
    const hasIncoming = incomingLinks && incomingLinks.length > 0;

    // Also check by basename (for wiki/发现/Foo.md referenced as [[Foo]])
    const basename = path.basename(targetKey);
    const basenameIncoming = incoming.get(basename);

    return !hasIncoming && !basenameIncoming;
  });

  orphans.sort((a, b) => a.path.localeCompare(b.path));

  console.log(`=== Orphans with outbound links but NO incoming links (${orphans.length}) ===\n`);

  if (orphans.length === 0) {
    console.log("🎉 No orphans found in wiki/发现/ or wiki/决策/!");
    return;
  }

  for (const p of orphans) {
    console.log(`  ${p.path}`);
    console.log(`    title: "${p.title}"`);
    console.log(`    links to: ${p.outboundLinks.slice(0, 5).join(", ")}${p.outboundLinks.length > 5 ? "..." : ""}`);

    // Suggest target pages that might want a backlink
    const linkTargets = p.outboundLinks
      .map((l) => l.split("|")[0].split("#")[0])
      .filter((t) => t.length > 0);
    if (linkTargets.length > 0) {
      console.log(`    💡 suggestion: add backlink to ${linkTargets[0]}`);
    }
    console.log("");
  }

  console.log("---");
  console.log("\n📋 To backfill, add to each target page's ## 🔗 相关链接 section:");
  console.log('e.g. `- [[source-page]]`\n');
}

main();
