/**
 * pi-llm-wiki — Unit tests for pure functions.
 * Uses Node.js built-in test runner (node:test + node:assert).
 * Run: npx tsx --test tests/unit.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

/* ───────── manifest.ts ───────── */

import { parseFrontmatter, updateFrontmatter, quoteYaml } from "../src/manifest";

describe("parseFrontmatter", () => {
  it("parses simple frontmatter", () => {
    const md = `---
title: Test Page
tags: [test, demo]
status: active
---\n\nContent here.`;
    const fm = parseFrontmatter(md);
    assert.equal(fm.title, "Test Page");
    assert.equal(fm.tags, "[test, demo]");
    assert.equal(fm.status, "active");
  });

  it("handles boolean values", () => {
    const md = `---
compiled: true
weaved: false
---`;
    const fm = parseFrontmatter(md);
    assert.equal(fm.compiled, true);
    assert.equal(fm.weaved, false);
  });

  it("returns empty object when no frontmatter", () => {
    assert.deepEqual(parseFrontmatter("Just content."), {});
  });

  it("handles empty string", () => {
    assert.deepEqual(parseFrontmatter(""), {});
  });

  it("handles kebab-case keys", () => {
    const md = `---
session-id: abc123
last-updated: 2026-06-08
---`;
    const fm = parseFrontmatter(md);
    assert.equal(fm["session-id"], "abc123");
    assert.equal(fm["last-updated"], "2026-06-08");
  });
});

describe("quoteYaml", () => {
  it("passes through booleans unquoted", () => {
    assert.equal(quoteYaml(true), "true");
    assert.equal(quoteYaml(false), "false");
  });

  it("passes through numbers unquoted", () => {
    assert.equal(quoteYaml(42), "42");
    assert.equal(quoteYaml(3.14), "3.14");
  });

  it("quotes strings with YAML-special characters", () => {
    assert.equal(quoteYaml("hello: world"), '"hello: world"');
    assert.equal(quoteYaml("a#b"), '"a#b"');
    assert.equal(quoteYaml('say "hello"'), '"say \\"hello\\""');
  });

  it("passes through plain strings without quoting", () => {
    assert.equal(quoteYaml("hello world"), "hello world");
    assert.equal(quoteYaml("plain-text"), "plain-text");
  });
});

describe("updateFrontmatter", () => {
  it("updates existing frontmatter field", () => {
    const md = `---
title: Old Title
tags: [test]
---\n\nContent.`;
    const updated = updateFrontmatter(md, { title: "New Title", compiled: true });
    const fm = parseFrontmatter(updated);
    assert.equal(fm.title, "New Title");
    assert.equal(fm.compiled, true);
  });

  it("creates frontmatter if none exists", () => {
    const md = "Just content here.";
    const updated = updateFrontmatter(md, { title: "New Page" });
    assert.ok(updated.startsWith("---\ntitle: New Page\n---"));
    assert.ok(updated.includes("Just content here."));
  });

  it("preserves existing fields when updating", () => {
    const md = `---
a: 1
b: 2
---`;
    const updated = updateFrontmatter(md, { b: 3, c: 4 });
    const fm = parseFrontmatter(updated);
    assert.equal(fm.a, 1);
    assert.equal(fm.b, 3);
    assert.equal(fm.c, 4);
  });
});

/* ───────── query.ts ───────── */

import { matchScore, extractTags, parseAtlasLinks } from "../src/tools/query";

describe("matchScore", () => {
  it("returns 1 for exact substring match", () => {
    assert.equal(matchScore("hello", "hello world"), 1);
    assert.equal(matchScore("知识库", "知识库规则手册"), 1);
  });

  it("returns partial score for word overlap", () => {
    const score = matchScore("知识库 编译", "知识库 规则");
    assert.ok(score > 0 && score < 1, `Expected 0<score<1, got ${score}`);
  });

  it("returns 0 for completely unrelated strings", () => {
    assert.equal(matchScore("unrelated", "totally different content"), 0);
  });

  it("ignores single-character words", () => {
    assert.equal(matchScore("a b c", "hello world"), 0);
  });

  it("is case-insensitive", () => {
    assert.equal(matchScore("Hello", "hello world"), 1);
    assert.equal(matchScore("HELLO", "hello world"), 1);
  });
});

describe("extractTags", () => {
  it("extracts tags from frontmatter", () => {
    const md = `---
tags: [test, demo, wiki]
---\n\nContent.`;
    assert.deepEqual(extractTags(md), ["test", "demo", "wiki"]);
  });

  it("returns empty array when no tags", () => {
    const md = `---
title: No Tags
---`;
    assert.deepEqual(extractTags(md), []);
  });

  it("returns empty array when no frontmatter", () => {
    assert.deepEqual(extractTags("Just content."), []);
  });
});

describe("parseAtlasLinks", () => {
  it("parses wikilinks with descriptions", () => {
    const content = `- [[wiki/概念/Pi扩展]] — Pi 扩展编写模式\n- [[wiki/决策/技术决策]] — 技术决策记录`;
    const links = parseAtlasLinks(content);
    assert.equal(links.length, 2);
    assert.equal(links[0].path, "wiki/概念/Pi扩展");
    assert.equal(links[0].description, "Pi 扩展编写模式");
  });

  it("parses wikilinks without descriptions", () => {
    const content = `- [[wiki/孤立页面]]`;
    const links = parseAtlasLinks(content);
    assert.equal(links.length, 1);
    assert.equal(links[0].description, "");
  });

  it("returns empty array for content without links", () => {
    assert.deepEqual(parseAtlasLinks("# Just headers\nNo links."), []);
  });

  it("handles empty content", () => {
    assert.deepEqual(parseAtlasLinks(""), []);
  });
});

/* ───────── project.ts ───────── */

import { detectProject } from "../src/project";

describe("detectProject", () => {
  it("detects project from AGENTS.md within $HOME", () => {
    // pi-llm-wiki itself has no AGENTS.md, so this tests the fallback
    const result = detectProject(process.cwd());
    assert.ok(result !== null);
    assert.equal(typeof result.name, "string");
    assert.ok(result.name.length > 0);
  });

  it("falls back to directory name for paths outside $HOME", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const dir = "/tmp/pi-llm-wiki-test-fallback";
    fs.mkdirSync(dir, { recursive: true });
    const result = detectProject(dir);
    assert.equal(result?.name, path.basename(dir));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

/* ───────── client.ts (API integration) ───────── */

import { search, smartSearch } from "../src/client";

describe("search (API integration)", { timeout: 20_000 }, async () => {
  it("performs keyword search via REST API", async () => {
    const results = await search("schema", 5);
    assert.ok(Array.isArray(results));
    if (results.length > 0) {
      assert.ok(typeof results[0].filename === "string");
      assert.ok(typeof results[0].score === "number");
    }
  });

  it("returns empty array on empty query", async () => {
    const results = await search("", 5);
    assert.ok(Array.isArray(results));
  });
});

describe("smartSearch (API integration)", { timeout: 20_000 }, async () => {
  it("performs semantic search via Smart Connections", async () => {
    const results = await smartSearch("知识库规则与编译流程", 5);
    assert.ok(Array.isArray(results));
    if (results.length > 0) {
      assert.ok(typeof results[0].path === "string");
      assert.ok(results[0].score > 0);
    }
  });

  it("returns results ranked by score descending", async () => {
    const results = await smartSearch("知识库规则", 10);
    for (let i = 1; i < results.length; i++) {
      assert.ok(
        results[i].score <= results[i - 1].score,
        `Expected score[${i}] (${results[i].score}) <= score[${i - 1}] (${results[i - 1].score})`
      );
    }
  });
});
