# Implementation Plan

## Goal
Improve the pi-llm-wiki GLM/Zhipu extraction pipeline so raw sessions compile into richer wiki pages while respecting Zhipu rate limits, supporting configurable models, and falling back safely when extraction fails.

## Overview
- **Scope:** `obs-compile` extraction path in `src/tools/compile.ts`, shared LLM config in `src/config.ts`, and tests covering parsing/retry/config behavior.
- **Non-goals:** Do not add a persistent queue daemon, do not change the ingest summary format, and do not introduce model-specific prompt variants beyond the OpenAI-compatible chat-completions request shape.

## Tasks

1. **Phase A — Improve GLM prompt and structured parser**
   - File: `src/tools/compile.ts`
   - Changes:
     - Extend `StructuredSections` to include `summary?: string`, `tags?: string[]`, and `importance?: "high" | "medium" | "low"` or a small ranked list.
     - Update `parseStructuredBody()` to parse new sections for summary, tags, and importance while keeping existing goal/decisions/insights/issues parsing.
     - Treat `"暂无"` as empty sections instead of emitting a literal `暂无` wiki bullet.
     - Change the prompt body slice from `body.slice(0, 4000)` to `body.slice(0, INGEST_MAX_CHARS)` or `LLM_CONFIG.contextChars`.
     - Revise the prompt to request: concise wiki title/summary, goal, decisions, insights, unresolved issues, technology tags, and importance rank.
     - Update `buildWikiFromStructured()` to use the extracted summary/title when useful, include tags in frontmatter, and render importance only when present.
   - Acceptance:
     - A raw session with structured content compiles into a wiki page with summary, tags, ranked importance, and no literal `"暂无"` bullets.
     - A raw session with empty sections compiles without adding empty sections or placeholder bullets.
     - Existing compile tests still pass.

2. **Phase B — Add Zhipu rate-limit protection**
   - File: `src/tools/compile.ts`
   - Changes:
     - Add a retry loop around the chat-completions `fetch()` call.
     - Retry on `429` and selected transient server errors such as `500`, `502`, `503`, `504`.
     - Parse `Retry-After` as seconds or HTTP-date when present.
     - Use exponential backoff when no header is present: `baseDelay * 2^attempt`, capped by `maxRetryDelayMs`.
     - Add config for `maxRetries`, `retryBaseDelayMs`, `maxRetryDelayMs`, and optional `minIntervalMs` between extraction calls.
     - Keep the final fallback behavior: if all retry attempts fail, return `null` so `compile()` can fall back to raw copy.
     - Log retry events with model, attempt number, delay, and status code.
   - Acceptance:
     - A mocked `429` response followed by `200` succeeds without falling back to raw copy.
     - A mocked permanent `429` retries the configured number of times and then returns `null`.
     - `Retry-After: 2` produces a shorter wait than default exponential backoff in a controlled test.

3. **Phase C — Make model selection configurable and add fallback chain**
   - File: `src/config.ts`
   - Changes:
     - Replace hardcoded model assumptions with env-overridable config:
       - `LLM_WIKI_EXTRACT_MODEL`
       - `LLM_WIKI_EXTRACT_ENDPOINT`
       - `LLM_WIKI_EXTRACT_KEY`
       - `LLM_WIKI_EXTRACT_PROVIDER`
       - `LLM_WIKI_EXTRACT_TIMEOUT_MS`
       - `LLM_WIKI_EXTRACT_MAX_TOKENS`
     - Keep existing `ZHIPU_API_KEY` as the default key when no override is set.
     - Add optional fallback config:
       - `LLM_WIKI_FALLBACK_MODEL`
       - `LLM_WIKI_FALLBACK_ENDPOINT`
       - `LLM_WIKI_FALLBACK_KEY`
       - `LLM_WIKI_FALLBACK_PROVIDER`
     - Default primary remains Zhipu GLM-4-Flash; default secondary can be SiliconFlow OpenAI-compatible endpoint using `$SILICONFLOW_API_KEY`.
   - File: `src/tools/compile.ts`
   - Changes:
     - Refactor `summarizeWithGLM()` into a small provider-call helper that accepts a model config object.
     - Try primary provider → secondary provider → `null` (raw copy fallback).
     - Do not retry the secondary provider if it is not configured.
     - Preserve the same prompt and parser across providers.
   - Acceptance:
     - Setting `LLM_WIKI_EXTRACT_MODEL` overrides the model used in the request body.
     - Setting `LLM_WIKI_EXTRACT_ENDPOINT` overrides the endpoint.
     - If primary extraction fails and fallback provider config exists, the fallback provider is called.
     - If neither provider succeeds, compile still succeeds using the raw-copy fallback path.

4. **Phase D — Add tests for parser, retry, and end-to-end extraction**
   - File: `tests/unit.test.ts`
   - Changes:
     - Add unit tests for `parseStructuredBody()` covering summary, tags, importance, empty sections, and `"暂无"` handling.
   - File: `tests/pipeline.test.ts`
   - Changes:
     - Add retry test with a mocked global `fetch()` returning `429` then `200`.
     - Add retry exhaustion test returning repeated `429`.
     - Add config override test for `LLM_WIKI_EXTRACT_MODEL` and `LLM_WIKI_EXTRACT_ENDPOINT`.
     - Add end-to-end compile test where mocked fetch returns a valid structured extraction and verify the wiki page includes summary/tags/importance.
   - Acceptance:
     - `LLM_WIKI_TEST_VAULT=/tmp/test-vault-llm-wiki npx tsx --test tests/*.test.ts` passes.
     - Tests do not call real APIs unless the user explicitly enables them.
     - Mocked tests restore the original `globalThis.fetch` and environment variables after each run.

## Files to Modify
- `src/config.ts` — add env-overridable extraction/fallback config and retry timing defaults.
- `src/tools/compile.ts` — improve prompt, parser, wiki rendering, retry loop, provider fallback chain, and logging.
- `tests/unit.test.ts` — add parser unit tests.
- `tests/pipeline.test.ts` — add retry/config/integration tests using mocked `fetch()`.

## New Files
- No new files required.

## Dependencies
- Phase A must land before Phase C because the prompt/parser contract is needed by both primary and fallback providers.
- Phase B can be implemented before Phase C because retry logic is provider-agnostic.
- Phase D should be interleaved: parser tests after Phase A, retry/config tests after Phases B/C, end-to-end test after the full extraction helper exists.

## Acceptance Criteria
- Richer extraction: compiled wiki pages include summary, tags, and importance when the model provides them.
- Graceful degradation: invalid model output, empty sections, API errors, and rate limits never break the compile command.
- Rate limiting: `429` responses trigger retry with `Retry-After` support and exponential backoff.
- Configurable models: Zhipu primary model/endpoint/key can be overridden with environment variables.
- Fallback chain: primary → secondary → raw copy works without requiring code changes.
- Verification: full test suite passes with `LLM_WIKI_TEST_VAULT=/tmp/test-vault-llm-wiki npx tsx --test tests/*.test.ts`.

## Risk Assessment
- **Zhipu rate limits:** Even with retry, batch compile can still hit RPM limits. Keep `maxRetries` modest and add `minIntervalMs` to avoid hammering the API.
- **Retry delays:** Long `Retry-After` values can make compile slow. Cap the effective wait or skip retry when the header exceeds a configured maximum.
- **Prompt drift:** Different models may ignore the requested section format. Keep parser tolerant and fallback to raw copy when parsing fails.
- **Provider compatibility:** SiliconFlow and other providers may use OpenAI-compatible endpoints, but response shapes can vary. Normalize only the fields needed: `choices[0].message.content`.
- **Token budget:** Raising context to 3000 chars is safe for GLM-4-Flash, but avoid adding long raw conversation dumps in the prompt.
- **Secrets:** Do not commit API keys. Use env vars only.

## Implementation Order Recommendation
1. Implement Phase A first: better prompt + parser + empty-section handling.
2. Add Phase A parser tests before changing API behavior.
3. Implement Phase B: retry/backoff/`Retry-After`.
4. Add Phase B retry tests with mocked `fetch()`.
5. Implement Phase C: env-overridable primary config + optional fallback provider.
6. Add Phase C config/fallback tests.
7. Run the full test suite and one real compile only if the user has `ZHIPU_API_KEY` available.

## Reviewer Checklist
- Confirm `compile()` still falls back to raw copy when extraction returns `null`.
- Confirm no API keys are written to files or tests.
- Confirm mocked tests restore both `globalThis.fetch` and environment variables.
- Confirm `Retry-After` parsing handles both seconds and HTTP-date formats.
- Confirm the prompt uses `INGEST_MAX_CHARS`/config rather than a stale `4000` hard-coded slice.
