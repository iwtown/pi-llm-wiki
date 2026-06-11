# Phase 5: Optimization Plan — Reliability, Efficiency, Elegance

> Based on ORACLE_REVIEW.md analysis. 3 priority issues: ZInBox pipeline, bimodal extraction, state simplification.
> **Estimated total effort: 18-26 hours**

---

## Executive Summary

| Priority | Issue | Impact | Effort |
|----------|-------|--------|--------|
| **P1** | ZInBox as parallel pipeline (二等公民) | High — bypasses all quality control, O(400) startup scan | 10-14h |
| **P2** | Bimodal extraction quality | Medium — 50% of sessions get low-quality fallback | 4-6h |
| **P3** | Over-engineered state tracking | Medium — fragile YAML parsing, edge cases in Phase 0 | 4-6h |

**Recommended order: P3 → P1 → P2**

Rationale:
- **P3 first**: State simplification is foundational. Changing state format affects all files. Do this before P1 (which adds ZInBox state tracking).
- **P1 second**: ZInBox integration is the biggest single chunk. Do it with fresh context.
- **P3 last**: Bimodal fix is isolated to agent-end.ts. Can be done independently.

---

## P1: ZInBox Pipeline Integration (10-14h)

### Problem

`autoCompileZinbox()` in `refresh.ts:265-385` bypasses the entire `ingest → compile → weave → lint` pipeline:

```
Current state:
  Sessions: ingest → raw/sessions/ → compile → wiki/  ✅ Full pipeline
  ZInBox:   autoCompileZinbox() → wiki/引用/          ❌ Direct write, no quality control
```

**Consequences:**
- No `scoreContent()` quality gate — low-quality clippings pollute wiki
- No `parent_session_id` tracking — fork detection impossible
- No insight extraction — ZInBox content never analyzed for upgrades
- O(400) filesystem ops every startup (scans entire ZInBox)
- Inconsistent wiki quality — sessions have structured insight logs, ZInBox has raw body

### Approach

**Option A: Full Integration (Recommended)**
Make ZInBox clippings go through ingest→compile pipeline:
1. ZInBox → `raw/clippings/zinbox/YYYY-MM-DD-<title>.md` (ingest step)
2. Then processed by `autoCompile()` like sessions
3. Pros: Uniform quality, single code path, full pipeline benefits
4. Cons: Requires `obs_ingest` tool to support non-session input

**Option B: Hybrid (Fallback)**
Keep direct compile but add:
1. `scoreContent()` gate on ZInBox body
2. Incremental scan (track compiled ZInBox files)
3. Optional: extract insights and log for upgrade detection

**Recommendation: Option B (Hybrid)** — lower risk, no tool API changes.

### Files to Modify

| File | Function/Lines | Change |
|------|----------------|--------|
| `src/system/refresh.ts` | `autoCompileZinbox()` (265-385) | Add `scoreContent()` gate, incremental scan |
| `src/tools/ingest.ts` | Export `scoreContent()` | Move from private to exported |
| `src/system/changes.ts` | `logChange()` | Add `type: "zinbox"` support |
| `src/config.ts` | `LLM_WIKI.zinboxIndex` | Keep as-is (already exists) |
| `raw/zinbox-index/` | Marker files | Add `score` field to frontmatter |

### Implementation Steps

**Step 1.1: Export scoreContent()** (30min)
- File: `src/tools/ingest.ts`
- Change: Export `scoreContent()` function (currently private)
- Acceptance: Can import from other modules

**Step 1.2: Add score gate to autoCompileZinbox()** (1h)
- File: `src/system/refresh.ts` line 300-310
- Change: Call `scoreContent(body)` before compiling; skip if `score < 30`
- Acceptance: Trivial ZInBox clippings skipped, logged to debug

**Step 1.3: Incremental ZInBox scan** (2h)
- File: `src/system/refresh.ts` line 270-285
- Change: Track last-scan timestamp; only scan files modified since last run
- Store timestamp in `.pi/agent/zinbox-last-scan.json`
- Acceptance: Startup time reduced from O(400) to O(delta)

**Step 1.4: Log ZInBox compiles to changes.ts** (30min)
- File: `src/system/changes.ts` + `refresh.ts:350`
- Change: `logChange({ type: "zinbox", path: wikiPath, action: "create" })`
- Acceptance: ZInBox appears in change log for weave/lint

**Step 1.5: Extract insights from ZInBox** (2h)
- File: `src/system/refresh.ts` line 340-360
- Change: After creating wiki page, scan body for insights (💡/发现/陷阱 keywords)
- Append to a global insight log: `wiki/索引/zinbox-insights.md`
- Acceptance: Insights logged for future upgrade detection

**Step 1.6: Add compiled_to tracking for ZInBox** (1h)
- File: `raw/zinbox-index/*.md` marker files
- Change: Add `wiki: "wiki/引用/<title>.md"` frontmatter field
- Acceptance: Can trace ZInBox source → wiki page

**Step 1.7: Add ZInBox to status page** (1h)
- File: `src/system/status.ts`
- Change: Include ZInBox compile count in stats
- Acceptance: `wiki/状态.md` shows ZInBox stats

### Risks

| Risk | Mitigation |
|------|------------|
| Existing 388 ZInBox compiled pages unaffected? | Yes — incremental scan only applies to new clippings |
| Scoring threshold too aggressive? | Log skipped scores; adjust threshold if needed |
| Incremental scan misses files? | 24h full scan fallback (reuse `needsFullScan()` logic) |
| ZInBox insights extraction is crude? | Mark as "experimental"; v2 can use LLM extraction |

### Verification

```bash
# Count ZInBox files
find /mnt/d/DB/Obsidian/ZInBox -name "*.md" | wc -l  # Expected: ~400

# Check marker index
ls raw/zinbox-index/ | wc -l  # Should match compiled count

# Trigger before_agent_start hook, observe timing
time pi ask "test"  # Should see reduced startup time

# Verify skipped clippings logged
cat ~/.pi/agent/pi-llm-wiki-debug.log | grep "zinbox-skip"
```

---

## P3: Simplify Pipeline State Tracking (4-6h)

### Problem

Three boolean fields (`compiled`, `weaved`, `linted`) cause:
- YAML parsing edge cases (Phase 0 showed `"compiled: false"` vs no field)
- 8 possible states (2³=8), but only 4 are valid: pending→compiled→woven→done
- Redundant with `compiled_to` and `linked_to` arrays
- Every scan must parse and check 3 fields per file

**Current state:**
```yaml
compiled: false    # Has it been compiled?
weaved: false      # Have backlinks been appended?
linted: false      # Has lint passed?
compiled_to: wiki/发现/foo.md  # Where did it compile to?
linked_to: [bar, baz]         # What pages does it link to?
```

**Desired state:**
```yaml
status: pending    # pending | compiled | woven | done | skipped
compiled_to: wiki/发现/foo.md
linked_to: [bar, baz]
```

### Approach

Migrate to single `status` enum field:
- `pending` — not yet compiled
- `compiled` — wiki page created, not yet woven
- `woven` — backlinks appended, not yet linted
- `done` — pipeline complete
- `skipped` — fork/trivial/duplicate (Phase 0 states)

**Migration strategy:**
1. Read current 3 booleans
2. Compute status: if compiled=false → pending; if weaved=false → compiled; if linted=false → woven; else → done
3. Write status field, keep old fields for 90-day backward compatibility

### Files to Modify

| File | Function/Lines | Change |
|------|----------------|--------|
| `src/config.ts` | Add `PIPELINE_STATUS` type | New enum type |
| `src/manifest.ts` | `SessionStatus`, `markCompiled()`, `markWeaved()`, `markLinted()` | Migrate to status field |
| `src/system/refresh.ts` | `autoCompile()`, `autoWeave()` | Check status instead of booleans |
| `src/tools/compile.ts` | Compile result marking | Set `status: compiled` |
| `src/tools/weave.ts` | Weave completion | Set `status: woven` |
| `src/system/changes.ts` | Change log types | Add status transitions |
| `scripts/migrate-status.ts` | **NEW** migration script | One-time migration |

### Implementation Steps

**Step 3.1: Define PIPELINE_STATUS type** (30min)
- File: `src/config.ts`
- Change: Add `export type PipelineStatus = 'pending' | 'compiled' | 'woven' | 'done' | 'skipped'`

**Step 3.2: Update manifest.ts interfaces** (1h)
- File: `src/manifest.ts`
- Change: `SessionStatus` interface adds `status: PipelineStatus`, deprecate `compiled/weaved/linted`
- Keep `compiled/weaved/linted` as computed properties for 90-day compatibility

**Step 3.3: Create migration script** (2h)
- File: `scripts/migrate-pipeline-status.ts` (NEW)
- Logic:
  ```
  For each raw/sessions/**/*.md:
    Read frontmatter
    Compute status from 3 booleans
    Write status field
    Keep old fields (don't delete — backward compat)
  Log summary: how many in each status
  ```
- Acceptance: All 113 sessions have `status` field after migration

**Step 3.4: Update markCompiled/markWeaved/markLinted** (1h)
- File: `src/manifest.ts`
- Change: Each function now sets `status` field instead of boolean
- Keep setting old field for compatibility

**Step 3.5: Update refresh.ts checks** (1h)
- File: `src/system/refresh.ts`
- Change: `String(fm.compiled) !== "true"` → `fm.status !== 'done' && fm.status !== 'compiled' && fm.status !== 'woven'`
- Simplify logic: pending sessions are `status === 'pending' || !status`

**Step 3.6: Update compile.ts result marking** (30min)
- File: `src/tools/compile.ts`
- Change: Call `markCompiled(rawPath, { status: 'compiled', ... })`

**Step 3.7: Verification** (30min)
- Run `tsc --noEmit` — zero errors
- Run 34 unit tests — all pass
- Run migration script — verify counts

### Risks

| Risk | Mitigation |
|------|------------|
| Migration corrupts files? | Script creates backup `.bak` files; can restore |
| Old fields conflict with new status? | Status is source of truth; old fields ignored after 90 days |
| Hook sees mixed state during migration? | Migration is atomic per file; hooks are idempotent |
| Markdown parsing edge cases? | Use existing `updateFrontmatter()` which handles YAML |

### Verification

```bash
# Before migration
grep -c "compiled: false" raw/sessions/*/*.md

# Run migration
pnpm tsx scripts/migrate-pipeline-status.ts

# After migration
grep -c "status: pending" raw/sessions/*/*.md
grep -c "status: done" raw/sessions/*/*.md

# Verify tsc
pnpm tsc --noEmit

# Verify tests
pnpm test
```

---

## P2: Merge Bimodal Summarizers (4-6h)

### Problem

`agent-end.ts` has two summary builders with ~50% duplicated logic:

```
buildAutoSummary(obs, refs)   — Uses OM observations, structured output (🟢 High quality)
buildFallbackSummary(entries) — Concatenates user messages (🟡 Low quality)
```

**Consequences:**
- When OM unavailable, quality drops significantly
- Duplicate code: `extractUserMessages()`, date formatting, section building
- No graceful degradation — fallback should use LLM, not just copy messages

### Approach

**Merge into tiered summarizer:**
```
unifiedBuildSummary(entries, omData):
  If OM data available:
    Use structured observations/reflections (current buildAutoSummary)
  Else if session has ≥5 user messages:
    Use LLM to extract structure from messages (new — call LLM API)
  Else:
    Use message concatenation fallback (minimal, low-cost)
```

**Key change:** Fallback should optionally use LLM to extract 🎯/⚖️/💡 structure from raw messages, not just copy them.

### Files to Modify

| File | Function/Lines | Change |
|------|----------------|--------|
| `src/hooks/agent-end.ts` | Lines 83-156 | Merge two functions into `buildUnifiedSummary()` |
| `src/tools/ingest.ts` | Add optional LLM extraction | New function `extractStructuredFromMessages()` |
| `src/config.ts` | Add config flag | `FALLBACK_USE_LLM: boolean` |

### Implementation Steps

**Step 2.1: Create unified summarizer** (2h)
- File: `src/hooks/agent-end.ts` line 83-156
- Change: Merge `buildAutoSummary` + `buildFallbackSummary` into `buildUnifiedSummary(entries)`
- Logic:
  ```
  If OM data present → use current buildAutoSummary
  Else if config.FALLBACK_USE_LLM → call LLM API to extract structure
  Else → use current fallback (copy messages)
  ```

**Step 2.2: Add LLM extraction function** (2h)
- File: `src/tools/ingest.ts` (or new `src/tools/extract.ts`)
- Change: New function `extractStructuredFromMessages(messages: string[])`
- Uses Pi LLM API with prompt: "Extract goals/decisions/insights from these session messages"
- Timeout: 10s (don't block agent_end too long)

**Step 2.3: Add config flag** (15min)
- File: `src/config.ts`
- Change: `export const FALLBACK_USE_LLM = false` (default off — can enable after testing)

**Step 2.4: Update autoIngest()** (30min)
- File: `src/hooks/agent-end.ts` line 158-200
- Change: Call `buildUnifiedSummary()` instead of two separate functions
- Log which tier was used (OM / LLM / fallback)

**Step 2.5: Testing** (30min)
- Run 34 unit tests (no changes expected)
- Manual test: trigger agent_end without OM, verify fallback works
- Enable `FALLBACK_USE_LLM=true`, verify LLM extraction

### Risks

| Risk | Mitigation |
|------|------------|
| LLM extraction adds latency to agent_end | 10s timeout; runs async; log duration |
| LLM extraction costs money | Config flag defaults to false; user opts in |
| Extraction prompt needs tuning | Mark as "experimental" in v1; iterate on prompt |
| Token usage increases | Limit extraction to 200 tokens max output |

### Verification

```bash
# Verify tsc
pnpm tsc --noEmit

# Verify tests
pnpm test

# Manual test: trigger agent_end
# Check debug log for which tier was used
cat ~/.pi/agent/pi-llm-wiki-debug.log | grep "buildUnifiedSummary"

# Check raw session quality (should see structure even without OM)
head -30 raw/sessions/*/*.md | grep -A5 "🎯\|⚖️\|💡"
```

---

## Dependencies

```
P3 (State) → P1 (ZInBox) → P2 (Bimodal)

P3 first because:
  - State format affects ALL files (113 sessions + ZInBox markers)
  - P1 adds ZInBox state tracking — should use new format from start
  - P2 is independent, can be done last

P1 before P2 because:
  - P1 is larger chunk (10-14h), do with fresh context
  - P2 is isolated to agent-end.ts, can be done any time
```

---

## Risk Matrix

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| ZInBox integration breaks existing 388 compiled pages | Low | High | Incremental approach — only new clippings use new path |
| State migration corrupts files | Medium | High | Backup `.bak` files, 90-day backward compat |
| LLM fallback adds unacceptable latency | Medium | Medium | 10s timeout, config flag defaults off |
| Bimodal fix doesn't improve quality | Medium | Low | Config flag allows rollback; A/B test with logs |

---

## Success Metrics

| Metric | Before | After (Target) |
|--------|--------|----------------|
| ZInBox startup scan | O(400) full scan | O(delta) incremental |
| Trivial ZInBox compiled | 0% filtered | 100% filtered (score < 30) |
| Pipeline state edge cases | 37 stuck sessions | 0 stuck (single enum) |
| Bimodal quality gap | 50% low-quality fallback | <10% (LLM extraction) |
| Code duplication | 2 summary functions | 1 unified function |

---

## Phase 6+ Future Considerations (Not in Scope)

After P1/P2/P3 complete, consider:
- **Contradiction detection frequency tuning** — currently runs every lint (>1000 pages, consider weekly)
- **obs_admin tool splitting** — currently muxes 4 actions; split into 4 tools
- **dlog/slog unification** — single structured log with human-readable formatter
- **status.ts full scan optimization** — currently O(633) pages every startup

---

## Appendix: Current Code State (Reference)

**Files already modified in Phases 0-4:**
- `src/tools/ingest.ts` — scoreContent() (Phase 4)
- `src/system/refresh.ts` — autoCompile delegates to compile.ts (Phase 2)
- `src/system/changes.ts` — incremental change log (Phase 3)
- `src/manifest.ts` — compiled/weaved/linted tracking
- `src/hooks/agent-end.ts` — buildAutoSummary + buildFallbackSummary (bimodal)
- `scripts/cleanup-stuck-sessions.ts` — Phase 0 cleanup
- `scripts/merge-fork-sessions.ts` — Phase 1 fork merge

**New files to create:**
- `scripts/migrate-pipeline-status.ts` — P3 migration
- `src/tools/extract.ts` — P2 LLM extraction (optional)