/**
 * pi-llm-wiki — Pipeline integration tests.
 * Tests ingest → compile → weave flow using an isolated temp vault.
 *
 * Run: LLM_WIKI_TEST_VAULT=/tmp/test-vault-llm-wiki npx tsx --test tests/pipeline.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const TEST_VAULT = process.env.LLM_WIKI_TEST_VAULT || "/tmp/test-vault-llm-wiki";
const SESSIONS_DIR = path.join(TEST_VAULT, "raw/sessions/test-project");
const WIKI_DIR = path.join(TEST_VAULT, "wiki");

// We must set the env var BEFORE importing modules that read config
process.env.LLM_WIKI_TEST_VAULT = TEST_VAULT;
// Rest API calls will fail in test — that's fine, ingest falls back to fs

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ingest } from "../src/tools/ingest";

// Create a minimal ExtensionContext for testing
function makeCtx(overrides?: Record<string, unknown>): ExtensionContext {
  return {
    cwd: process.cwd(),
    sessionManager: {
      sessionId: "test-session-001",
      getBranch: () => [],
      getSessionId: () => "test-session-001",
    } as any,
    ...overrides,
  } as any;
}

describe("pipeline: ingest", () => {
  before(() => {
    // Clean and recreate test vault
    fs.rmSync(TEST_VAULT, { recursive: true, force: true });
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  });

  after(() => {
    fs.rmSync(TEST_VAULT, { recursive: true, force: true });
  });

  it("ingest creates raw session with correct frontmatter", async () => {
    const ctx = makeCtx({ sessionManager: { sessionId: "ingest-test-001", getBranch: () => [], getSessionId: () => "ingest-test-001" } } as any);
    const result = await ingest(
      [
        "## 会话复盘 — 2026-06-11",
        "",
        "### 🎯 目标",
        "",
        "测试 ingest 功能，验证文件创建",
        "",
        "### ⚖️ 决策",
        "",
        "选用方案 B，因为更稳定",
        "",
        "### 💡 洞察",
        "",
        "发现了一个陷阱：需要处理边界情况",
        "",
        "### ⚠️ 遗留",
        "",
        "需要验证写入正确性",
      ].join("\n"),
      ctx
    );

    // Should write successfully (either API or fs fallback)
    assert.ok(result.path.length > 0, "ingest should return a path");
    assert.ok(result.writeMode === "fs" || result.writeMode === "api",
      `writeMode should be 'fs' or 'api', got '${result.writeMode}'`);

    // Verify file exists
    const fullPath = path.join(TEST_VAULT, result.path);
    assert.ok(fs.existsSync(fullPath), `file should exist at ${fullPath}`);

    // Verify frontmatter
    const content = fs.readFileSync(fullPath, "utf-8");
    assert.ok(content.includes("title:"), "should have title");
    assert.ok(content.includes("session_id:"), "should have session_id");
    assert.ok(content.includes("session_score:"), "should have session_score");
    assert.ok(content.includes("compiled: false"), "should have compiled: false");
    assert.ok(content.includes("### 🎯 目标"), "should preserve content");
  });

  it("ingest marks session with session_score for structured content", async () => {
    const ctx = makeCtx({ sessionManager: { sessionId: "score-test-002", getBranch: () => [], getSessionId: () => "score-test-002" } } as any);
    const content = [
      "## 会话复盘",
      "",
      "### 🎯 目标",
      "",
      "测试评分功能",
      "",
      "### ⚖️ 决策",
      "",
      "采用方案 A",
    ].join("\n");
    const result = await ingest(content, ctx);

    assert.ok(result.path.length > 0, "ingest should return a path for structured content");
    const fullPath = path.join(TEST_VAULT, result.path);
    assert.ok(fs.existsSync(fullPath), `file should exist at ${fullPath}`);
    const fileContent = fs.readFileSync(fullPath, "utf-8");
    assert.ok(fileContent.includes("session_score:"), "should have score");
    const scoreMatch = fileContent.match(/session_score:\s*(\d+)/);
    assert.ok(scoreMatch, "score should be a number");
    assert.ok(parseInt(scoreMatch[1]) >= 30, "structured content should score >= 30, got " + scoreMatch[1]);
  });
});

describe("pipeline: ingest + compile", () => {
  before(() => {
    fs.rmSync(TEST_VAULT, { recursive: true, force: true });
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  });

  after(() => {
    fs.rmSync(TEST_VAULT, { recursive: true, force: true });
  });

  it("ingest dedup by session_id", async () => {
    const uniqueId = "dup-test-" + Date.now();
    const ctx = makeCtx({ sessionManager: { sessionId: uniqueId, getBranch: () => [], getSessionId: () => uniqueId } } as any);

    // First ingest — content must be high-scoring to not be skipped
    const content = [
      "## 会话复盘",
      "",
      "### 🎯 目标",
      "",
      "首次 ingest 测试",
      "",
      "### ⚖️ 决策",
      "",
      "采用方案 B",
    ].join("\n");
    const result1 = await ingest(content, ctx);
    assert.ok(result1.writeMode === "fs" || result1.writeMode === "api",
      `first ingest should succeed, got ${result1.writeMode}`);

    // Second ingest with same session_id
    const result2 = await ingest(content, ctx);
    assert.equal(result2.writeMode, "skip", "duplicate should be skipped");
  });
});

describe("pipeline: compile", () => {
  before(() => {
    fs.rmSync(TEST_VAULT, { recursive: true, force: true });
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    fs.mkdirSync(path.join(WIKI_DIR, "发现"), { recursive: true });
    fs.mkdirSync(path.join(WIKI_DIR, "项目", "test-project"), { recursive: true });
  });

  after(() => {
    fs.rmSync(TEST_VAULT, { recursive: true, force: true });
  });

  it("compile creates wiki page and marks raw as compiled", async () => {
    // First create a raw session with proper frontmatter
    const rawContent = `---
title: "Test Compile"
project: "test-project"
date: 2026-06-11
session_id: "compile-test-001"
session_score: 85
trivial: false
compiled: false
weaved: false
linted: false
tags: [session, test-project]
---

# Test Compile

- [ ] 编译: Test Compile 📅 2026-06-11

## 会话复盘

### 🎯 目标

测试编译功能

### ⚖️ 决策

采用 CI
`;

    const rawPath = "raw/sessions/test-project/2026-06-11-compile-test.md";
    fs.mkdirSync(path.dirname(path.join(TEST_VAULT, rawPath)), { recursive: true });
    fs.writeFileSync(path.join(TEST_VAULT, rawPath), rawContent, "utf-8");

    // Call compile
    const { compile } = await import("../src/tools/compile");
    const result = await compile(rawPath, {}, { cwd: process.cwd() } as any);

    assert.ok(result, "compile should return result");
    assert.ok(result.wikiPath, `should have wiki path, got ${JSON.stringify(result)}`);

    // Verify wiki file exists
    const wikiFullPath = path.join(TEST_VAULT, result.wikiPath);
    assert.ok(fs.existsSync(wikiFullPath), `wiki file should exist at ${wikiFullPath}`);

    // Verify wiki frontmatter
    const wikiContent = fs.readFileSync(wikiFullPath, "utf-8");
    assert.ok(wikiContent.includes("title: \"Test Compile\""), "wiki should have title");
    assert.ok(wikiContent.includes("source: \"raw/sessions/test-project/2026-06-11-compile-test.md\""), "wiki should reference source");

    // Verify raw session was marked compiled
    const rawUpdated = fs.readFileSync(path.join(TEST_VAULT, rawPath), "utf-8");
    assert.ok(rawUpdated.includes("compiled: true"), "raw should be marked compiled");
    // Check for Tasks checkbox updated
    assert.ok(rawUpdated.includes("[x]"), "tasks checkbox should be checked");
  });

  it("compile handles dedup for existing topics", async () => {
    // Create a wiki page first
    const existingWikiPath = "wiki/发现/existing-topic.md";
    fs.writeFileSync(path.join(TEST_VAULT, existingWikiPath), `---
title: "Existing Topic"
tags: [wiki/发现]
---

# Existing Topic

Some content
`, "utf-8");

    // Create raw session with similar title
    const rawContent = `---
title: "Existing Topic"
project: "test-project"
date: 2026-06-11
session_id: "dedup-test-001"
session_score: 80
trivial: false
compiled: false
tags: [session, test-project]
---

# Existing Topic

Similar content
`;

    const rawPath = "raw/sessions/test-project/2026-06-11-dedup-test.md";
    fs.writeFileSync(path.join(TEST_VAULT, rawPath), rawContent, "utf-8");

    const { compile } = await import("../src/tools/compile");
    const result = await compile(rawPath, {}, { cwd: process.cwd() } as any);

    assert.ok(result, "compile should return result");
    assert.ok(result.dedupSuggestion, "should return dedup suggestion when topic exists");
  });
});
