/**
 * pi-llm-wiki — Tests for changes.ts (incremental change log).
 * Uses temp file at test path; saves/restores real change log.
 * Run: npx tsx --test tests/changes.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const HOME = process.env.HOME || os.homedir();
const REAL_CHANGES = path.join(HOME, ".pi/agent/pi-llm-wiki-changes.json");
const BACKUP_CHANGES = REAL_CHANGES + ".testbak";

// Dynamically import changes.ts after potential HOME manipulation
// Use direct filesystem path since PATHS.changes uses process.env.HOME at module load time.
// Actually, PATHS uses process.env.HOME at import time. We can't change HOME after import.
// Instead, we test the logic by calling the functions and managing the file lifecycle.

import {
  readChangeLog, writeChangeLog, logChange,
  getCachedFiles, updateCache, needsFullScan, isRelevantPendingPath
} from "../src/system/changes";

describe("changes.ts — change log", () => {
  // Backup real file before tests, restore after
  before(() => {
    if (fs.existsSync(REAL_CHANGES)) {
      fs.copyFileSync(REAL_CHANGES, BACKUP_CHANGES);
    }
  });

  after(() => {
    // Restore real file
    if (fs.existsSync(BACKUP_CHANGES)) {
      fs.copyFileSync(BACKUP_CHANGES, REAL_CHANGES);
      fs.rmSync(BACKUP_CHANGES);
    }
  });

  // Clean test state before each test
  function resetTestFile(data?: object) {
    if (fs.existsSync(REAL_CHANGES)) {
      fs.rmSync(REAL_CHANGES);
    }
    if (data) {
      fs.mkdirSync(path.dirname(REAL_CHANGES), { recursive: true });
      fs.writeFileSync(REAL_CHANGES, JSON.stringify(data));
    }
  }

  it("readChangeLog returns defaults when file missing", () => {
    resetTestFile();
    const cl = readChangeLog();
    assert.equal(cl.version, 1);
    assert.deepEqual(cl.changes, []);
    assert.equal(cl.cache, null);
    assert.ok(typeof cl.lastFullScan === "string");
  });

  it("logChange writes entry and can be read back", () => {
    resetTestFile();
    logChange({ type: "ingest", path: "raw/sessions/test/a.md", action: "create", timestamp: "2026-06-11" });
    logChange({ type: "compile", path: "wiki/发现/test.md", action: "create", timestamp: "2026-06-11", wikiPath: "wiki/发现/test.md" });

    const cl = readChangeLog();
    assert.equal(cl.changes.length, 2);
    assert.equal(cl.changes[0].type, "ingest");
    assert.equal(cl.changes[0].path, "raw/sessions/test/a.md");
    assert.equal(cl.changes[1].type, "compile");
    assert.equal(cl.changes[1].wikiPath, "wiki/发现/test.md");
  });

  it("needsFullScan returns true when cache missing", () => {
    resetTestFile();
    assert.equal(needsFullScan(), true);
  });

  it("needsFullScan returns false when cache is fresh", () => {
    resetTestFile({
      version: 1,
      lastFullScan: new Date().toISOString(),
      changes: [],
      cache: { rawSessions: ["a.md"], wikiPages: ["b.md"], lastScanned: new Date().toISOString() },
    });
    assert.equal(needsFullScan(), false);
  });

  it("updateCache and getCachedFiles round-trip", () => {
    resetTestFile();
    updateCache(["raw/sessions/pi/a.md"], ["wiki/发现/b.md"]);
    const cached = getCachedFiles();
    assert.deepEqual(cached.raw, ["raw/sessions/pi/a.md"]);
    assert.deepEqual(cached.wiki, ["wiki/发现/b.md"]);
    assert.ok(cached.lastScanned.length > 0);
  });

  it("isRelevantPendingPath filters correctly", () => {
    assert.equal(isRelevantPendingPath("raw/sessions/pi/test.md"), true);
    assert.equal(isRelevantPendingPath("raw/sessions/test.md"), true);
    assert.equal(isRelevantPendingPath("wiki/发现/test.md"), false);
    assert.equal(isRelevantPendingPath("raw/sessions/pi/crash-recovery-abc.md"), false);
    assert.equal(isRelevantPendingPath("raw/sessions/pi/test.txt"), false);
    assert.equal(isRelevantPendingPath("config.ts"), false);
    assert.equal(isRelevantPendingPath(""), false);
  });
});
