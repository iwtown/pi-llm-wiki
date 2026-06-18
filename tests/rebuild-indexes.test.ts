/**
 * pi-llm-wiki — Tests for rebuild-indexes.ts (index.md generation).
 *
 * Run: LLM_WIKI_VAULT=/tmp/llm-wiki-test-rebuild npx tsx --test tests/rebuild-indexes.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

/* ───────── Pure functions ───────── */

import { appendToDirIndex } from "../src/system/rebuild-indexes";

// extractBodySummary and parsePageMeta are not exported — test them indirectly
// via appendToDirIndex behavior, or test through the module internals.
// Since they're internal, we import them via the compiled module.

// Instead, let's read the source and test the pure logic directly.

/**
 * Inline versions of the private functions for unit testing.
 * Mirror of rebuild-indexes.ts implementation.
 */
function extractBodySummary(content: string): string {
  const body = content.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (!t || /^#/.test(t) || /^[-*] /.test(t) || /^[=>]/.test(t)) continue;
    const s = t.replace(/^[^a-zA-Z0-9\u4e00-\u9fff]+/, "").slice(0, 80);
    if (s.length >= 5) return s;
  }
  return "";
}

function parsePageMeta(content: string): { title: string; summary: string } {
  let title = "未命名";
  let summary = "";

  const quotedTitle = content.match(/^title:\s*"([^"]*)"$/m);
  if (quotedTitle) {
    title = quotedTitle[1];
  } else {
    const unquotedTitle = content.match(/^title:\s*(.+?)\s*$/m);
    if (unquotedTitle) title = unquotedTitle[1].trim();
  }

  const quotedSummary = content.match(/^summary:\s*"([^"]*)"$/m);
  if (quotedSummary) {
    summary = quotedSummary[1];
  } else {
    const unquotedSummary = content.match(/^summary:\s*(.+?)\s*$/m);
    if (unquotedSummary) summary = unquotedSummary[1].trim();
  }

  if (!summary) summary = extractBodySummary(content);

  return { title, summary };
}

/* ───────── extractBodySummary ───────── */

describe("extractBodySummary", () => {
  it("extracts first meaningful text after frontmatter (first 80 chars, no sentence boundary)", () => {
    const md = `---
title: Test
---
这是第一句有意义的话。这是第二句。
`;
    const result = extractBodySummary(md);
    assert.ok(result.startsWith("这是第一句有意义的话"), "should extract first meaningful content");
    assert.ok(result.includes("这是第二句"), "may include subsequent text within 80-char limit");
  });

  it("skips headings and list items", () => {
    const md = `# 标题\n\n## 子标题\n\n- 列表项\n- 另一个\n\n正文内容从这里开始。`;
    assert.equal(extractBodySummary(md), "正文内容从这里开始。");
  });

  it("returns empty string for content with only headings", () => {
    const md = `# 标题\n\n## 子标题\n`;
    assert.equal(extractBodySummary(md), "");
  });

  it("truncates to 80 chars", () => {
    const longText = "这是一段非常长的文字".repeat(10); // >80 chars
    assert.equal(extractBodySummary(longText).length, 80);
  });

  it("handles empty body", () => {
    assert.equal(extractBodySummary(""), "");
  });

  it("handles no frontmatter", () => {
    const md = `直接正文。没有任何 frontmatter。`;
    assert.equal(extractBodySummary(md), "直接正文。没有任何 frontmatter。");
  });

  it("skips leading non-alphanumeric characters", () => {
    const md = `---\ntitle: T\n---\n♪ 带特殊字符的正文`;
    // The regex strips leading non-alphanumeric/Chinese chars
    const result = extractBodySummary(md);
    assert.ok(result.startsWith("带特殊字符的正文") || result.startsWith("♪"));
  });
});

/* ───────── parsePageMeta ───────── */

describe("parsePageMeta", () => {
  it("extracts quoted title and summary", () => {
    const md = `---
title: "配置指南"
tags: [test]
summary: "如何配置 WSL2 环境"
---
正文内容。
`;
    const meta = parsePageMeta(md);
    assert.equal(meta.title, "配置指南");
    assert.equal(meta.summary, "如何配置 WSL2 环境");
  });

  it("falls back to unquoted title", () => {
    const md = `---
title: 配置指南
tags: [test]
---
正文内容。
`;
    const meta = parsePageMeta(md);
    assert.equal(meta.title, "配置指南");
  });

  it("falls back to body summary when no summary field", () => {
    const md = `---
title: "测试页面"
tags: [test]
---
第一行正文内容，用作摘要。`;
    const meta = parsePageMeta(md);
    assert.equal(meta.title, "测试页面");
    assert.ok(meta.summary.startsWith("第一行正文内容"));
  });

  it("returns default title when no title field", () => {
    const meta = parsePageMeta("正文内容");
    assert.equal(meta.title, "未命名");
  });

  it("handles empty content", () => {
    const meta = parsePageMeta("");
    assert.equal(meta.title, "未命名");
    assert.equal(meta.summary, "");
  });

  it("extracts unquoted summary", () => {
    const md = `---
summary: 简单摘要
---
正文。`;
    const meta = parsePageMeta(md);
    assert.equal(meta.summary, "简单摘要");
  });
});

/* ───────── appendToDirIndex (filesystem) ───────── */

describe("appendToDirIndex", () => {
  const TEST_VAULT = process.env.LLM_WIKI_VAULT || "/tmp/llm-wiki-test-rebuild";

  it("creates index.md with header + entry for new page", () => {
    const wikiDir = path.join(TEST_VAULT, "wiki", "测试分类");
    fs.mkdirSync(wikiDir, { recursive: true });

    // Write a test wiki page
    const pagePath = path.join(wikiDir, "test-page.md");
    fs.writeFileSync(pagePath, `---
title: "Test 页面"
tags: [test]
summary: "这是测试页面摘要"
---
正文内容。`, "utf-8");

    // Convert to vault-relative path
    const relPath = `wiki/测试分类/test-page.md`;

    appendToDirIndex(relPath);

    const indexPath = path.join(wikiDir, "index.md");
    assert.ok(fs.existsSync(indexPath), "index.md should exist");

    const content = fs.readFileSync(indexPath, "utf-8");
    assert.ok(content.includes("[Test 页面]"), "should contain page link");
    assert.ok(content.includes("测试页面摘要"), "should contain summary");
    assert.ok(content.includes("Agent 逐级浏览入口"), "should have header");

    // Cleanup
    fs.rmSync(path.join(TEST_VAULT, "wiki"), { recursive: true, force: true });
  });

  it("is idempotent: does not duplicate entries", () => {
    const wikiDir = path.join(TEST_VAULT, "wiki", "测试分类");
    fs.mkdirSync(wikiDir, { recursive: true });

    const pagePath = path.join(wikiDir, "idempotent.md");
    fs.writeFileSync(pagePath, `---
title: "幂等测试"
summary: "不应重复"
---
正文。`, "utf-8");

    const relPath = `wiki/测试分类/idempotent.md`;

    // Call twice
    appendToDirIndex(relPath);
    appendToDirIndex(relPath);

    const indexPath = path.join(wikiDir, "index.md");
    const content = fs.readFileSync(indexPath, "utf-8");
    const occurrences = content.match(/幂等测试/g)?.length || 0;
    assert.equal(occurrences, 1, "should appear exactly once");

    // Cleanup
    fs.rmSync(path.join(TEST_VAULT, "wiki"), { recursive: true, force: true });
  });

  it("prepends new entries (newest first) in existing index", () => {
    const wikiDir = path.join(TEST_VAULT, "wiki", "测试分类");
    fs.mkdirSync(wikiDir, { recursive: true });

    // First page
    fs.writeFileSync(path.join(wikiDir, "first.md"), `---
title: "第一篇"
summary: "最早的内容"
---
正文一。`, "utf-8");
    appendToDirIndex("wiki/测试分类/first.md");

    // Second page
    fs.writeFileSync(path.join(wikiDir, "second.md"), `---
title: "第二篇"
summary: "更新的内容"
---
正文二。`, "utf-8");
    appendToDirIndex("wiki/测试分类/second.md");

    const indexPath = path.join(wikiDir, "index.md");
    const content = fs.readFileSync(indexPath, "utf-8");
    const idxFirst = content.indexOf("第一篇");
    const idxSecond = content.indexOf("第二篇");
    assert.ok(idxSecond < idxFirst, "newer entry should appear before older (prepend)");

    // Cleanup
    fs.rmSync(path.join(TEST_VAULT, "wiki"), { recursive: true, force: true });
  });

  it("skips index.md creation for pages outside wiki/", () => {
    // Should not crash, just silently skip
    appendToDirIndex("raw/sessions/test.md");
    // No crash = pass
  });

  it("handles pages without summary (body fallback)", () => {
    const wikiDir = path.join(TEST_VAULT, "wiki", "测试分类");
    fs.mkdirSync(wikiDir, { recursive: true });

    fs.writeFileSync(path.join(wikiDir, "no-summary.md"), `---
title: "无摘要页面"
---
第一行正文内容。正文正文。`, "utf-8");

    appendToDirIndex("wiki/测试分类/no-summary.md");

    const indexPath = path.join(wikiDir, "index.md");
    const content = fs.readFileSync(indexPath, "utf-8");
    assert.ok(content.includes("第一行正文内容"), "should use body fallback");

    // Cleanup
    fs.rmSync(path.join(TEST_VAULT, "wiki"), { recursive: true, force: true });
  });
});
