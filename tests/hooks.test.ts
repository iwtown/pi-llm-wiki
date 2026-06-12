/**
 * pi-llm-wiki — Tests for lifecycle hooks (agent-end + before-start).
 * Uses exported pure functions directly — no mocking needed for logic tests.
 * Run: LLM_WIKI_TEST_VAULT=/tmp/test-vault-llm-wiki npx tsx --test tests/hooks.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

/* ───────── agent-end.ts — extractMessageText ───────── */

import { extractMessageText } from "../src/hooks/agent-end";

describe("extractMessageText", () => {
  it("extracts from plain string", () => {
    assert.equal(extractMessageText("hello"), "hello");
  });

  it("extracts from { content: string }", () => {
    assert.equal(extractMessageText({ content: "hello" }), "hello");
  });

  it("extracts from { text: string }", () => {
    assert.equal(extractMessageText({ text: "hello" }), "hello");
  });

  it("extracts from ContentBlock array", () => {
    const msg = {
      content: [
        { type: "text", text: "hello " },
        { type: "text", text: "world" },
      ],
    };
    assert.equal(extractMessageText(msg), "hello  world");
  });

  it("returns empty string for null/undefined", () => {
    assert.equal(extractMessageText(null), "");
    assert.equal(extractMessageText(undefined), "");
  });

  it("filters non-text blocks", () => {
    const msg = {
      content: [
        { type: "text", text: "hello" },
        { type: "image", text: "img" },
        { type: "input_text", text: " world" },
      ],
    };
    assert.equal(extractMessageText(msg), "hello  world");
  });
});

/* ───────── agent-end.ts — extractUserMessages ───────── */

import { extractUserMessages } from "../src/hooks/agent-end";

describe("extractUserMessages", () => {
  it("extracts old-format user messages (type: user)", () => {
    const entries = [
      { type: "user", message: "帮我配置" },
      { type: "assistant", message: "好的" },
      { type: "user", message: "谢谢" },
    ];
    const msgs = extractUserMessages(entries);
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0], "帮我配置");
    assert.equal(msgs[1], "谢谢");
  });

  it("extracts new-format user messages (type: message, role: user)", () => {
    const entries = [
      { type: "message", message: { role: "user", content: "Hello" } },
      { type: "message", message: { role: "assistant", content: "Hi" } },
    ];
    const msgs = extractUserMessages(entries);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0], "Hello");
  });

  it("handles mixed old/new format", () => {
    const entries = [
      { type: "user", message: "old" },
      { type: "message", message: { role: "user", content: "new" } },
      { type: "custom", customType: "obs" },
    ];
    const msgs = extractUserMessages(entries);
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0], "old");
    assert.equal(msgs[1], "new");
  });

  it("returns empty array for no user messages", () => {
    assert.deepEqual(extractUserMessages([]), []);
    assert.deepEqual(
      extractUserMessages([{ type: "assistant", message: "hi" }]),
      []
    );
  });
});

/* ───────── agent-end.ts — extractObservations ───────── */

import { extractObservations, type OmObservation, type OmReflection } from "../src/hooks/agent-end";

describe("extractObservations", () => {
  it("extracts observations from custom entries", () => {
    const entries = [
      {
        type: "custom",
        customType: "om.observations.recorded",
        data: {
          observations: [
            { id: "obs1", content: "发现了一个 bug", relevance: "high" },
            { id: "obs2", content: "用户配置了 SSL", relevance: "medium" },
          ],
        },
      },
    ];
    const result = extractObservations(entries);
    assert.equal(result.obs.length, 2);
    assert.equal(result.obs[0].content, "发现了一个 bug");
    assert.equal(result.obs[1].relevance, "medium");
  });

  it("extracts reflections from custom entries", () => {
    const entries = [
      {
        type: "custom",
        customType: "om.reflections.recorded",
        data: {
          reflections: [
            { id: "ref1", content: "应该用方案 B", supportingObservationIds: ["obs1"] },
          ],
        },
      },
    ];
    const result = extractObservations(entries);
    assert.equal(result.refs.length, 1);
    assert.equal(result.refs[0].content, "应该用方案 B");
  });

  it("handles entries without observations", () => {
    const result = extractObservations([{ type: "user", message: "hi" }]);
    assert.equal(result.obs.length, 0);
    assert.equal(result.refs.length, 0);
  });
});

/* ───────── agent-end.ts — buildTier1Summary ───────── */

import { buildTier1Summary } from "../src/hooks/agent-end";

describe("buildTier1Summary", () => {
  it("includes user goal from first message", () => {
    const obs: OmObservation[] = [];
    const refs: OmReflection[] = [];
    const userMsgs = ["帮我配置 WezTerm 的中文输入法"];
    const result = buildTier1Summary(obs, refs, userMsgs, "2026-06-12");
    assert.ok(result.includes("帮我配置 WezTerm"), "should include user goal");
    assert.ok(result.includes("OM 数据"), "should indicate OM data source");
  });

  it("includes critical observations", () => {
    const obs: OmObservation[] = [
      { id: "o1", content: "SSL 证书过期了", relevance: "critical", timestamp: "", sourceEntryIds: [], tokenCount: 0 },
    ];
    const result = buildTier1Summary(obs, [], [], "2026-06-12");
    assert.ok(result.includes("SSL 证书过期了"), "should include critical obs");
    assert.ok(result.includes("🔴"), "should mark critical section");
  });

  it("includes high observations", () => {
    const obs: OmObservation[] = [
      { id: "o1", content: "配置了新的证书", relevance: "high", timestamp: "", sourceEntryIds: [], tokenCount: 0 },
    ];
    const result = buildTier1Summary(obs, [], [], "2026-06-12");
    assert.ok(result.includes("配置了新的证书"), "should include high obs");
    assert.ok(result.includes("🟡"), "should mark high section");
  });

  it("handles empty obs gracefully", () => {
    const result = buildTier1Summary([], [], ["用户消息"], "2026-06-12");
    assert.ok(result.includes("用户消息"), "still includes user message");
    assert.ok(result.includes("2026-06-12"), "includes date");
  });
});

/* ───────── agent-end.ts — buildTier2Summary ───────── */

import { buildTier2Summary } from "../src/hooks/agent-end";

describe("buildTier2Summary", () => {
  it("uses first message as goal", () => {
    const result = buildTier2Summary(["调研 WezTerm 配置", "用方案 A"], "2026-06-12");
    assert.ok(result.includes("调研 WezTerm 配置"), "first msg as goal");
    assert.ok(result.includes("方案 A"), "second msg as decision");
  });

  it("handles single message", () => {
    const result = buildTier2Summary(["简单问题"], "2026-06-12");
    assert.ok(result.includes("简单问题"), "single msg as goal");
  });

  it("includes activity log for multiple messages", () => {
    const msgs = ["任务一", "任务二", "任务三", "任务四", "任务五", "任务六"];
    const result = buildTier2Summary(msgs, "2026-06-12");
    assert.ok(result.includes("6 条消息"), "activity log count");
  });
});

/* ───────── agent-end.ts — buildUnifiedSummary ───────── */

import { buildUnifiedSummary } from "../src/hooks/agent-end";

describe("buildUnifiedSummary", () => {
  it("returns null for no user messages", () => {
    const result = buildUnifiedSummary([], { obs: [], refs: [] });
    assert.equal(result!.summary, null, "no user msgs summary = null");
    assert.equal(result!.tier, "no-data", "tier = no-data");
  });

  it("prefers Tier 1 when OM data exists", () => {
    const entries = [
      { type: "user", message: "帮我配置" },
      { type: "custom", customType: "om.observations.recorded", data: { observations: [{ id: "o1", content: "配置完成", relevance: "high", timestamp: "", sourceEntryIds: [], tokenCount: 0 }] } },
    ];
    const result = buildUnifiedSummary(entries, { obs: [{ id: "o1", content: "配置完成", relevance: "high", timestamp: "", sourceEntryIds: [], tokenCount: 0 }], refs: [] });
    assert.ok(result, "should return summary");
    assert.equal(result!.tier, "tier1-om", "should be tier 1");
  });

  it("falls back to Tier 2 when no OM data and >=2 messages", () => {
    const entries = [
      { type: "user", message: "任务一" },
      { type: "assistant", message: "完成" },
      { type: "user", message: "任务二" },
    ];
    const result = buildUnifiedSummary(entries, { obs: [], refs: [] });
    assert.ok(result, "should return summary");
    assert.equal(result!.tier, "tier2-extract", "should be tier 2");
  });

  it("returns null for trivial (no OM, <2 messages)", () => {
    const entries = [{ type: "user", message: "hi" }];
    const result = buildUnifiedSummary(entries, { obs: [], refs: [] });
    assert.equal(result!.summary, null, "trivial summary = null");
    assert.equal(result!.tier, "skip-trivial", "tier = skip-trivial");
  });
});

/* ───────── before-start.ts — hook registration ───────── */

import { injectSchema } from "../src/hooks/before-start";

describe("injectSchema", () => {
  it("registers before_agent_start handler", async () => {
    let registeredEvent = "";
    const mockPi = {
      on: (event: string, _handler: any) => { registeredEvent = event; },
    } as any;

    await injectSchema(mockPi);
    assert.equal(registeredEvent, "before_agent_start", "should register on before_agent_start");
  });

  it("does not throw when called", async () => {
    const mockPi = {
      on: async (_event: string, handler: any) => {
        // Simulate triggering the handler
        if (handler) await handler({}, { cwd: process.cwd() });
      },
    } as any;

    // Should not throw — the handler handles errors internally
    await injectSchema(mockPi);
    assert.ok(true, "autoRefresh completed without throwing");
  });
});

/* ───────── refresh.ts — refreshSystemPages ───────── */

import { refreshSystemPages } from "../src/system/refresh";

describe("refreshSystemPages", () => {
  it("registers before_agent_start handler", () => {
    let registeredEvent = "";
    const mockPi = {
      on: (event: string, _handler: any) => { registeredEvent = event; },
      appendEntry: async () => {},
    } as any;

    refreshSystemPages(mockPi);
    assert.equal(registeredEvent, "before_agent_start", "should register on before_agent_start");
  });

  it("does not throw when handler is triggered", async () => {
    let handler: any = null;
    const mockPi = {
      on: (_event: string, h: any) => { handler = h; },
      appendEntry: async () => {},
    } as any;

    refreshSystemPages(mockPi);
    // Trigger the handler with minimal context
    if (handler) {
      await handler({ systemPrompt: "" }, { cwd: process.cwd() });
    }
    assert.ok(true, "handler completed without throwing");
  });
});

/* ───────── buildUnifiedSummary — OM quality gate ───────── */

import { buildUnifiedSummary } from "../src/hooks/agent-end";

describe("buildUnifiedSummary OM quality gate", () => {
  it("prefers Tier 1 when OM has critical/high observations", () => {
    const entries = [
      { type: "user", message: "帮我配置" },
      { type: "custom", customType: "om.observations.recorded", data: { observations: [{ id: "o1", content: "配置完成", relevance: "high", timestamp: "", sourceEntryIds: [], tokenCount: 0 }] } },
    ];
    const result = buildUnifiedSummary(entries, { obs: [{ id: "o1", content: "配置完成", relevance: "high", timestamp: "", sourceEntryIds: [], tokenCount: 0 }], refs: [] });
    assert.ok(result, "should return summary");
    assert.equal(result!.tier, "tier1-om", "high relevance → Tier 1");
  });

  it("falls through to Tier 2 when OM has only medium/low observations", () => {
    const entries = [
      { type: "user", message: "调研 WezTerm 配置" },
      { type: "assistant", message: "好的" },
      { type: "user", message: "用方案 A" },
      { type: "custom", customType: "om.observations.recorded", data: { observations: [{ id: "o1", content: "版本号 3.2.1", relevance: "medium", timestamp: "", sourceEntryIds: [], tokenCount: 0 }] } },
    ];
    const result = buildUnifiedSummary(entries, { obs: [{ id: "o1", content: "版本号 3.2.1", relevance: "medium", timestamp: "", sourceEntryIds: [], tokenCount: 0 }], refs: [] });
    assert.ok(result, "should return summary");
    assert.equal(result!.tier, "tier2-extract", "medium only → Tier 2");
  });
});
