/**
 * pi-llm-wiki — Main entry point.
 * Registers 3 knowledge management tools + 3 lifecycle hooks.
 *
 * Tools: obs-query (retrieval), obs-admin (capture/reference/aggregate/distill), obs-rate (feedback)
 * Hooks: before_agent_start (schema + knowledge preview), agent_end (auto ingest → compile → weave), startup-recovery
 *
 * Auto-handled (no tool registration needed — run via hooks):
 *   ingest          → agent_end auto-ingest
 *   compile → weave  → agent_end fire-and-forget (per session, non-blocking)
 *   lint             → manual (npm run pipeline) — full-scan, not per-session
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { injectSchema, injectPipelineCheck, buildIngestCache } from "../src/hooks/before-start";
import { autoIngest } from "../src/hooks/agent-end";
import { registerStartupRecovery } from "../src/hooks/startup-recovery";
import { refreshSystemPages } from "../src/system/refresh";
import { query } from "../src/tools/query";
import { capture } from "../src/tools/capture";
import { reference } from "../src/tools/reference";
import { aggregate } from "../src/tools/aggregate";
import { distill } from "../src/tools/distill";
import { ratePage } from "../src/tools/rate";
import { dlog } from "../src/system/log";

export default function (pi: ExtensionAPI) {
  // ─── Hooks ───────────────────────────────────────────────

  injectSchema(pi).catch((e) =>
    dlog(`before-start hook failed: ${e}`)
  );
  injectPipelineCheck(pi).catch((e) =>
    dlog(`pipeline-backlog hook failed: ${e}`)
  );
  // Build session ID dedup cache (non-blocking, runs at startup)
  buildIngestCache();
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
      "Faster, no API call. Use obs_query only for fuzzy or cross-category search.\n\n" +
      "写作规则：每个新页面需 >=2 条 [[wikilinks]]；写入前先搜索避免重复；" +
      "禁止创建孤立节点；用中文标题；不硬编码密钥。",
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
      "Keywords: 记下来, capture, 跨库, aggregate, 聚合, distill, 蒸馏.\n\n" +
      "保存规则：用中文标题；tags 首个为 wiki/类型 (概念/决策/发现/命令/流程/规则/提示)；" +
      "写入前先搜索避免重复。",
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
            content: [{ type: "text", text: `⚗️ 蒸馏完成: ${result.logCount} 条 -> 摘要` }],
            details: result,
          };
        }
        default:
          return { content: [{ type: "text", text: `❌ Unknown action: ${params.action}. Use: capture, reference, aggregate, distill.` }], details: null };
      }
    },
  });

  // ─── Tool: obs-rate — 主动反馈 ───

  pi.registerTool({
    name: "obs_rate",
    label: "obs-rate: Rate Wiki Page Quality",
    description:
      "评价 wiki 页面的有用性，驱动 quality_score 反馈循环。\n" +
      "用法: obs_rate path=wiki/发现/xxx.md rating=useful|outdated\n" +
      "• useful — 知识有帮助，quality_score + 查询计数\n" +
      "• outdated — 知识已过时，标记 stale，quality_score 下调",
    parameters: Type.Object({
      path: Type.String({ description: "Wiki 页面路径，如 wiki/发现/xxx.md" }),
      rating: Type.String({ description: "评价: useful 或 outdated" }),
    }),
    async execute(toolCallId: string, params: { path: string; rating: string }, _signal: AbortSignal, _onUpdate: unknown, _ctx: { cwd: string }) {
      if (!["useful", "outdated"].includes(params.rating)) {
        return { content: [{ type: "text", text: "❌ rating 必须是 useful 或 outdated" }], details: null };
      }
      const result = ratePage(params.path, params.rating as "useful" | "outdated");
      if (!result) {
        return { content: [{ type: "text", text: `❌ 无法评价 ${params.path} — 文件不存在或不可读` }], details: null };
      }
      return {
        content: [{ type: "text", text: `⭐ ${result.message} (score: ${result.quality_score})` }],
        details: result,
      };
    },
  });
}
