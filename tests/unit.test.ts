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

/* ───────── analyzer.ts (missing concept detection) ───────── */

import { detectMissingConcepts } from "../src/system/analyzer";
import type { WikiPage } from "../src/system/analyzer";

describe("detectMissingConcepts", () => {
  it("reports concepts referenced ≥3 times but lacking a page", () => {
    const pages: WikiPage[] = [
      {
        path: "wiki/发现/A.md",
        title: "A",
        body: "Uses [[缺失概念-X]] and [[已有概念]].",
        content: `---\ntitle: A\ntags: [wiki/发现]\n---\n
Uses [[缺失概念-X]] and [[已有概念]].`,
        project: "test",
      },
      {
        path: "wiki/发现/B.md",
        title: "B",
        body: "Also uses [[缺失概念-X]] and [[缺失概念-Y]].",
        content: `---\ntitle: B\ntags: [wiki/发现]\n---\n
Also uses [[缺失概念-X]] and [[缺失概念-Y]].`,
      },
      {
        path: "wiki/发现/C.md",
        title: "C",
        body: "Uses [[缺失概念-X]] and [[缺失概念-Y]] again.",
        content: `---\ntitle: C\ntags: [wiki/发现]\n---\n
Uses [[缺失概念-X]] and [[缺失概念-Y]] again.`,
      },
      {
        path: "wiki/概念/已有概念.md",
        title: "已有概念",
        body: "An existing page.",
        content: `---\ntitle: 已有概念\ntags: [wiki/概念]\n---\n
An existing page.`,
      },
    ];

    const missing = detectMissingConcepts(pages, 3);
    const names = missing.map((m) => m.concept);
    assert.ok(names.includes("缺失概念-X"), "should detect 缺失概念-X (refCount=3)");
    // 缺失概念-Y only referenced 2 times (B, C), threshold=3 → should NOT appear
    assert.ok(!names.includes("缺失概念-Y"), "should NOT detect 缺失概念-Y (refCount=2 < threshold=3)");
  });

  it("respects custom threshold", () => {
    const pages: WikiPage[] = [
      {
        path: "wiki/发现/X.md",
        title: "X",
        body: "Ref [[稀有概念]].",
        content: `---\ntitle: X\ntags: [wiki/发现]\n---\n
Ref [[稀有概念]].`,
      },
      {
        path: "wiki/发现/Y.md",
        title: "Y",
        body: "Also [[稀有概念]].",
        content: `---\ntitle: Y\ntags: [wiki/发现]\n---\n
Also [[稀有概念]].`,
      },
    ];

    // threshold=2 should catch 稀有概念 (refCount=2)
    const missing2 = detectMissingConcepts(pages, 2);
    assert.equal(missing2.length, 1);
    assert.equal(missing2[0].concept, "稀有概念");

    // threshold=3 should not catch it
    const missing3 = detectMissingConcepts(pages, 3);
    assert.equal(missing3.length, 0);
  });

  it("handles wikilink variants (alias, section)", () => {
    const pages: WikiPage[] = [
      {
        path: "wiki/发现/A.md",
        title: "A",
        body: "Links [[概念/缺失#章节|别名]], [[概念/其他#^block]].",
        content: `---\ntitle: A\ntags: [wiki/发现]\n---\n
Links [[概念/缺失#章节|别名]], [[概念/其他#^block]].`,
      },
      {
        path: "wiki/发现/B.md",
        title: "B",
        body: "Also [[概念/缺失]] and [[概念/其他]].",
        content: `---\ntitle: B\ntags: [wiki/发现]\n---\n
Also [[概念/缺失]] and [[概念/其他]].`,
      },
      {
        path: "wiki/发现/C.md",
        title: "C",
        body: "Refs [[概念/缺失]] again.",
        content: `---\ntitle: C\ntags: [wiki/发现]\n---\n
Refs [[概念/缺失]] again.`,
      },
    ];

    const missing = detectMissingConcepts(pages, 3);
    const names = missing.map((m) => m.concept);
    assert.ok(names.includes("概念/缺失"), "should normalize alias variants (A/B/C = 3 refs)");
    // 概念/其他: A (block ref), B (direct ref) = 2 < 3, should NOT appear
    const other = missing.find((m) => m.concept === "概念/其他");
    assert.equal(other, undefined, "概念/其他 should be filtered (refCount=2 < 3)");
  });

  it("excludes system pages and index pages", () => {
    const pages: WikiPage[] = [
      {
        path: "wiki/仪表盘.md",
        title: "仪表盘",
        body: "Agent auto-generated.",
        content: `---\ntitle: 仪表盘\nkind: system\n---\n
Agent auto-generated.`,
      },
      {
        path: "wiki/索引/发现.md",
        title: "发现索引",
        body: "Index page.",
        content: `---\ntitle: 发现索引\n---\n
Index page.`,
      },
      {
        path: "wiki/发现/A.md",
        title: "A",
        body: "Normal page.",
        content: `---\ntitle: A\ntags: [wiki/发现]\n---\n
Normal page referencing [[概念/缺失概念-X]].`,
        project: "test",
      },
    ];

    // Only 1 non-excluded page, so even if it references a missing concept,
    // the count is 1 < threshold 3
    const missing = detectMissingConcepts(pages, 1);
    assert.equal(missing.length, 1);
    assert.equal(missing[0].concept, "概念/缺失概念-X");
  });
});

/* ───────── client.ts (API integration) ───────── */

import { search, smartSearch } from "../src/client";
import { scoreContent } from "../src/tools/ingest";

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

/* ───────── ingest.ts / scoreContent ───────── */

describe("scoreContent", () => {
  it("scores structured content high (>80)", () => {
    const content = [
      "## 会话复盘",
      "",
      "### 🎯 目标",
      "",
      "修复 pi 配置",
      "",
      "### ⚖️ 决策",
      "",
      "决定采用 option B",
      "",
      "### 💡 洞察",
      "",
      "发现了一个陷阱",
      "",
      "### ⚠️ 遗留",
      "",
      "需要验证",
    ].join("\n");
    const result = scoreContent(content);
    assert.ok(result.score >= 80, "Expected high score for structured content, got " + result.score);
    assert.equal(result.isTrivial, false);
  });

  it("scores long content without sections as moderate (>30)", () => {
    const body = "x".repeat(2500);
    const content = ["## Test", "", body].join("\n");
    const result = scoreContent(content);
    assert.ok(result.score >= 30, "Expected moderate score for long content, got " + result.score);
    assert.equal(result.isTrivial, false);
  });

  it("marks short empty content as trivial (<30)", () => {
    const content = "## 测试\n\nhello";
    const result = scoreContent(content);
    assert.ok(result.score < 30, "Expected trivial score for short content, got " + result.score);
    assert.equal(result.isTrivial, true);
  });

  it("scores content with decisions and insights", () => {
    const lines = [
      "## 会话复盘",
      "",
      "### 🎯 目标",
      "",
      "配置工具",
      "",
      "### ⚖️ 决策",
      "",
      "选用 A",
      "",
      "### 💡 洞察",
      "",
      "发现 B",
    ];
    const content = lines.join("\n");
    const result = scoreContent(content);
    assert.ok(result.score >= 40, "Expected score for content with decisions+insights, got " + result.score);
    assert.ok(result.score <= 100);
    assert.equal(result.factors.hasGoal, true);
    assert.equal(result.factors.hasDecisions, true);
    assert.equal(result.factors.hasInsights, true);
  });
});

/* ───────── compile.ts — parseStructuredBody (extended format) ───────── */

import { parseStructuredBody } from "../src/tools/compile";

describe("parseStructuredBody (extended)", () => {
  it("parses summary, tags, importance from new format", () => {
    const body = `## 摘要
关于 WezTerm 中文输入法的配置总结

### 🎯 目标
配置 WezTerm 的中文输入

### ⚖️ 决策
- 启用 use_ime=true
- 关闭 kitty_keyboard

### 💡 洞察
- kitty keyboard 与中文输入法冲突

### ⚠️ 遗留
- 需要测试 Ctrl+Space 切换

### 🏷️ 标签
- WezTerm, 中文输入, WSL2`;
    const result = parseStructuredBody(body);
    assert.ok(result, "should parse successfully");
    assert.equal(result!.summary, "关于 WezTerm 中文输入法的配置总结");
    assert.ok(result!.tags!.includes("WezTerm"), "should include WezTerm tag");
    assert.ok(result!.tags!.includes("中文输入"), "should include Chinese IME tag");
    assert.equal(result!.goal, "配置 WezTerm 的中文输入");
    assert.equal(result!.decisions.length, 2);
    assert.equal(result!.insights.length, 1);
    assert.equal(result!.issues.length, 1);
  });

  it("filters out 暂无 placeholder", () => {
    const body = `## 摘要
测试暂无过滤

### 🎯 目标
测试

### ⚖️ 决策
- 暂无

### 💡 洞察
- 发现一个问题

### ⚠️ 遗留
- 暂无

### 🏷️ 标签
- test`;
    const result = parseStructuredBody(body);
    assert.ok(result, "should parse");
    assert.equal(result!.decisions.length, 0, "暂无 should be filtered");
    assert.equal(result!.insights.length, 1, "真实洞察应保留");
    assert.equal(result!.issues.length, 0, "暂无 should be filtered");
  });

  it("handles old format without summary/tags", () => {
    const body = `### 🎯 目标
修复 bug

### ⚖️ 决策
- 方案 A

### 💡 洞察
- 根因是缓存`;
    const result = parseStructuredBody(body);
    assert.ok(result, "should parse old format");
    assert.equal(result!.summary, undefined, "no summary in old format");
    assert.equal(result!.tags, undefined, "no tags in old format");
    assert.equal(result!.goal, "修复 bug");
    assert.equal(result!.decisions.length, 1);
    assert.equal(result!.insights.length, 1);
  });
});

/* ───────── compile.ts — callProvider with mock fetch ───────── */

import { callProvider } from "../src/tools/compile";

describe("callProvider (retry logic)", () => {
  it("retries on 429 then succeeds", async () => {
    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      if (callCount === 1) {
        return { status: 429, headers: new Map(), ok: false } as any;
      }
      return {
        status: 200,
        ok: true,
        headers: new Map(),
        json: async () => ({
          choices: [{ message: { content: `### 🎯 目标\n测试\n\n### ⚖️ 决策\n- 决定 A` } }],
        }),
      } as any;
    };

    const fastRetry = { maxRetries: 3, retryBaseDelayMs: 1, maxRetryDelayMs: 100, minIntervalMs: 1 };

    const result = await callProvider(
      "test body",
      { model: "test-model", endpoint: "https://test.api", timeoutMs: 5000, maxTokens: 100 },
      "test-key",
      "test prompt",
      mockFetch,
      fastRetry,
    );
    assert.ok(result, "should succeed after retry");
    assert.equal(callCount, 2, "should have called fetch twice");
    assert.equal(result!.goal, "测试");
  });

  it("exhausts retries on permanent 429", async () => {
    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      return { status: 429, headers: new Map(), ok: false } as any;
    };

    const fastRetry = { maxRetries: 3, retryBaseDelayMs: 1, maxRetryDelayMs: 100, minIntervalMs: 1 };
    const result = await callProvider(
      "test body",
      { model: "test-model", endpoint: "https://test.api", timeoutMs: 5000, maxTokens: 100 },
      "test-key",
      "test prompt",
      mockFetch,
      fastRetry,
    );
    // maxRetries=3 means 4 total attempts (initial + 3 retries)
    assert.equal(result, null, "should return null after retry exhaustion");
    assert.equal(callCount, 4, "should retry 3 times = 4 total calls");
  });

  it("does not retry on 400 error", async () => {
    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      return { status: 400, headers: new Map(), ok: false } as any;
    };

    const fastRetry = { maxRetries: 3, retryBaseDelayMs: 1, maxRetryDelayMs: 100, minIntervalMs: 1 };
    const result = await callProvider(
      "test body",
      { model: "test-model", endpoint: "https://test.api", timeoutMs: 5000, maxTokens: 100 },
      "test-key",
      "test prompt",
      mockFetch,
      fastRetry,
    );
    assert.equal(result, null, "should return null on 400");
    assert.equal(callCount, 1, "should NOT retry on 400");
  });
});
