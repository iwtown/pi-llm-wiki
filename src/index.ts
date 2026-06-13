/**
 * pi-llm-wiki — Main entry point.
 * Registers 2 knowledge management tools + 3 lifecycle hooks.
 *
 * Tools: obs-query (retrieval), obs-admin (capture/reference/aggregate/distill)
 * Hooks: before_agent_start (schema + auto-pipeline), agent_end (auto ingest), startup-recovery
 *
 * Auto-handled (no tool registration needed — run via hooks):
 *   ingest   → agent_end auto-ingest
 *   compile  → before_agent_start auto-compile (≥5 threshold)
 *   weave    → before_agent_start auto-weave after compile
 *   lint     → before_agent_start auto-lint after compile
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { injectSchema } from "./hooks/before-start";
import { autoIngest } from "./hooks/agent-end";
import { registerStartupRecovery } from "./hooks/startup-recovery";
import { refreshSystemPages } from "./system/refresh";
import { query } from "./tools/query";
import { capture } from "./tools/capture";
import { reference } from "./tools/reference";
import { aggregate } from "./tools/aggregate";
import { distill } from "./tools/distill";
import { dlog } from "./system/log";

export default function (pi: ExtensionAPI) {
  // ─── Hooks ───────────────────────────────────────────────

  injectSchema(pi).catch((e) =>
    dlog(`before-start hook failed: ${e}`)
  );
  autoIngest(pi).catch((e) =>
    dlog(`agent-end hook failed: ${e}`)
  );
  registerStartupRecovery(pi);
  refreshSystemPages(pi);

  // ─── Tool: obs-query (retrieval) ──────────────────────────

  pi.registerTool({
    name: "obs_query",
    label: "obs-query: Knowledge Base Search",
    description:
      "Search all LLM-Wiki pages by keyword. Returns titles, snippets, tags. " +
      "Keywords: 查知识库, 搜索wiki, 之前怎么做的.\n\n" +
      "IMPORTANT: For known categories (concepts/decisions/discoveries/commands/projects), " +
      "just read the Dataview index (wiki/索引/某类.md) to list pages, then read the target directly. " +
      "Faster, no API call. Use obs_query only for fuzzy or cross-category search.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query." }),
      scope: Type.Optional(
        Type.String({ description: "Scope: 'all', 'wiki', 'raw', 'zinbox', 'prompt', 'gene', or vault name. 'prompt' only searches wiki/提示/. 'gene' only searches wiki/基因/." })
      ),
      limit: Type.Optional(
        Type.Number({ description: "Max results (default: 3)." })
      ),
      depth: Type.Optional(
        Type.String({ description: "'brief' (titles), 'normal' (snippets), 'full' (content). Default: normal." })
      ),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const results = await query(params.query, { scope: params.scope, limit: params.limit, depth: params.depth as "brief" | "normal" | "full" | undefined }, ctx);
      if (results.length === 0) {
        return {
          content: [{ type: "text", text: "📭 未找到匹配结果。" }],
          details: { results: [] },
        };
      }
      const text = results
        .map(
          (r, i) =>
            `${i + 1}. **${r.title}** (${r.path}${r.source ? `, ${r.source}` : ""}, score: ${r.score.toFixed(2)})\n   ${r.snippet.slice(0, 150)}${r.tags?.length ? `\n   🏷️ ${r.tags.join(", ")}` : ""}`
        )
        .join("\n\n");
      return {
        content: [{ type: "text", text: `🔍 "${params.query}":\n\n${text}` }],
        details: { results },
      };
    },
  });

  // ─── Tool: obs-admin (capture / reference / aggregate / distill) ───

  pi.registerTool({
    name: "obs_admin",
    label: "obs-admin: Knowledge Admin Functions",
    description:
      "Admin operations on the LLM-Wiki. Use the `action` parameter to pick which: " +
      "capture (save insight), reference (cross-vault ref), aggregate (quarterly summary), distill (compress logs). " +
      "Keywords: 记下来, capture, 跨库, aggregate, 聚合, distill, 蒸馏.",
    parameters: Type.Object({
      action: Type.String({ description: "One of: capture, reference, aggregate, distill." }),
      // capture params
      title: Type.Optional(Type.String({ description: "Title (required for capture)." })),
      content: Type.Optional(Type.String({ description: "Markdown content (required for capture)." })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Tags (optional)." })),
      wikiType: Type.Optional(
        Type.String({ description: "Category: 概念, 发现, 决策, 命令, 项目. Default: 发现." })
      ),
      relatedPages: Type.Optional(
        Type.Array(Type.String(), { description: "Related wiki pages to link." })
      ),
      // reference params
      sourceVault: Type.Optional(Type.String({ description: "Source vault: 'Works' or 'MemPalace' (required for reference)." })),
      sourcePath: Type.Optional(Type.String({ description: "Path in source vault (required for reference)." })),
      note: Type.Optional(Type.String({ description: "Context note (required for reference)." })),
      // aggregate params
      year: Type.Optional(Type.Number({ description: "Year (required for aggregate/distill)." })),
      quarter: Type.Optional(Type.Number({ description: "Quarter 1-4 (required for aggregate)." })),
      project: Type.Optional(Type.String({ description: "Optional project filter for aggregate." })),
      // distill params
      pagePath: Type.Optional(Type.String({ description: "Wiki page path (required for distill)." })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      switch (params.action) {
        case "capture": {
          if (!params.title || !params.content) {
            return { content: [{ type: "text", text: "❌ capture requires title and content." }], details: null };
          }
          const result = await capture(params.title, params.content, { tags: params.tags, wikiType: params.wikiType, relatedPages: params.relatedPages }, ctx);
          return {
            content: [{ type: "text", text: `💾 ${result.action === "created" ? "已保存" : "已更新"} → ${result.path}` }],
            details: result,
          };
        }
        case "reference": {
          if (!params.sourceVault || !params.sourcePath || !params.note) {
            return { content: [{ type: "text", text: "❌ reference requires sourceVault, sourcePath, and note." }], details: null };
          }
          const result = await reference(params.sourceVault, params.sourcePath, params.note, { tags: params.tags }, ctx);
          return {
            content: [{ type: "text", text: `📎 已创建跨库引用 → ${result.path}` }],
            details: result,
          };
        }
        case "aggregate": {
          if (!params.year || !params.quarter) {
            return { content: [{ type: "text", text: "❌ aggregate requires year and quarter." }], details: null };
          }
          const result = await aggregate({ year: params.year, quarter: params.quarter, project: params.project }, ctx);
          if (!result) {
            return { content: [{ type: "text", text: `📭 ${params.year} Q${params.quarter} 无内容可聚合。` }], details: null };
          }
          return {
            content: [{ type: "text", text: `📚 ${params.year} Q${params.quarter} 聚合完成 → ${result.pageCount} 页，${result.keyThemes.length} 主题` }],
            details: result,
          };
        }
        case "distill": {
          if (!params.pagePath) {
            return { content: [{ type: "text", text: "❌ distill requires pagePath." }], details: null };
          }
          const result = await distill(params.pagePath, ctx);
          if (!result) {
            return { content: [{ type: "text", text: `📭 ${params.pagePath} 无日志可蒸馏。` }], details: null };
          }
          return {
            content: [{ type: "text", text: `⚗️ 蒸馏完成: ${result.logCount} 条 → 摘要` }],
            details: result,
          };
        }
        default:
          return { content: [{ type: "text", text: `❌ Unknown action: ${params.action}. Use: capture, reference, aggregate, distill.` }], details: null };
      }
    },
  });
}
