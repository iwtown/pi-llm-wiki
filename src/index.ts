/**
 * pi-llm-wiki — Main entry point.
 * Registers 9 knowledge management tools + 3 lifecycle hooks for Pi Agent × Obsidian LLM-Wiki.
 *
 * Tools: obs-ingest, obs-query, obs-compile, obs-weave, obs-lint, obs-capture, obs-reference, obs-aggregate, obs-distill
 * Hooks: before_agent_start (inject schema), agent_end (auto ingest safety net)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { injectSchema } from "./hooks/before-start";
import { autoIngest, markIngested } from "./hooks/agent-end";
import { registerStartupRecovery } from "./hooks/startup-recovery";
import { refreshSystemPages } from "./system/refresh";
import { ingest } from "./tools/ingest";
import { query } from "./tools/query";
import { compile } from "./tools/compile";
import { weave } from "./tools/weave";
import { lint } from "./tools/lint";
import { capture } from "./tools/capture";
import { reference } from "./tools/reference";
import { aggregate } from "./tools/aggregate";
import { distill } from "./tools/distill";

export default function (pi: ExtensionAPI) {
  // ─── Hooks ───────────────────────────────────────────────

  injectSchema(pi).catch((e) =>
    console.error("[pi-llm-wiki] before-start hook failed:", e)
  );
  autoIngest(pi).catch((e) =>
    console.error("[pi-llm-wiki] agent-end hook failed:", e)
  );
  registerStartupRecovery(pi);
  refreshSystemPages(pi);

  // ─── Tool: obs-ingest ────────────────────────────────────

  pi.registerTool({
    name: "obs_ingest",
    label: "obs-ingest: Session Retrospective",
    description:
      "Write a session retrospective to raw/sessions/<project>/ in the LLM-Wiki vault. " +
      "Extracts goals, decisions, insights, and open issues (≤500 words). " +
      "Triggers: session end, 复盘, ingest, 会话结束.",
    parameters: Type.Object({
      content: Type.String({
        description: "Session retrospective in markdown. Must include: 🎯goals, ⚖️decisions, 💡insights, ⚠️open issues.",
      }),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await ingest(params.content, ctx);
      markIngested(pi); // prevent agent_end from creating duplicate
      return {
        content: [
          {
            type: "text",
            text: `✅ 已复盘会话到 LLM-Wiki\n> 文件: ${result.path}\n> 项目: ${result.project}`,
          },
        ],
        details: result,
      };
    },
  });

  // ─── Tool: obs-query ─────────────────────────────────────

  pi.registerTool({
    name: "obs_query",
    label: "obs-query: Knowledge Base Search",
    description:
      "Search the LLM-Wiki knowledge base. Returns titles, snippets, and tags. " +
      "Use for: looking up past decisions, concepts, commands, project knowledge. " +
      "Keyword triggers: 查知识库, 搜索wiki, obs-query, 之前怎么做的.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query for the knowledge base." }),
      scope: Type.Optional(
        Type.String({ description: "Search scope: 'all', 'wiki', 'raw', or a vault name." })
      ),
      limit: Type.Optional(
        Type.Number({ description: "Max results (default: 3)." })
      ),
      depth: Type.Optional(
        Type.String({ description: "Search depth: 'brief' (titles only), 'normal' (snippets), 'full' (page content). Default: 'normal'." })
      ),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const results = await query(params.query, { scope: params.scope, limit: params.limit, depth: params.depth as "brief" | "normal" | "full" | undefined }, ctx);
      if (results.length === 0) {
        return {
          content: [{ type: "text", text: "📭 LLM-Wiki 中未找到匹配结果。" }],
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
        content: [{ type: "text", text: `🔍 搜索 "${params.query}":\n\n${text}` }],
        details: { results },
      };
    },
  });

  // ─── Tool: obs-compile ───────────────────────────────────

  pi.registerTool({
    name: "obs_compile",
    label: "obs-compile: Compile Raw → Wiki",
    description:
      "Compile a raw/sessions/ file into a structured wiki/ page with double-links. " +
      "Returns linkedTo paths for obs-weave follow-up. " +
      "Triggers: when ≥5 uncompiled raw sessions exist, or user says 编译, compile.",
    parameters: Type.Object({
      rawPath: Type.String({ description: "Path to the raw session file, e.g. 'raw/sessions/Pi-Agent/2026-06-05-foo.md'." }),
      wikiType: Type.Optional(
        Type.String({ description: "Wiki category: 概念, 决策, 命令, 流程, 发现, 项目. Default: 发现." })
      ),
      links: Type.Optional(
        Type.Array(Type.String(), { description: "List of existing wiki pages to link to." })
      ),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await compile(
        params.rawPath,
        { wikiType: params.wikiType, links: params.links },
        ctx
      );
      if (!result) {
        return {
          content: [{ type: "text", text: `❌ 编译失败：无法读取 ${params.rawPath}。` }],
          details: { error: "file not found or invalid format" },
        };
      }
      const linkedList = result.linkedTo.map((l) => `  - [[${l}]]`).join("\n");
      const insightsLine =
        result.insights.length > 0
          ? `💡 提取到 ${result.insights.length} 条洞察:\n${result.insights.map((s) => `  - ${s}`).join("\n")}\n\n`
          : "";
      const upgradeLine =
        result.upgrades && result.upgrades.length > 0
          ? `🚀 知识升级: ${result.upgrades.length} 条洞察已跨项目验证:\n${result.upgrades.map((u) => `  - "${u.insight.slice(0, 60)}..." → ${u.projectCount} 个项目 → 建议 ${u.suggestedTarget}`).join("\n")}\n\n`
          : "";
      return {
        content: [
          {
            type: "text",
            text:
              `✅ 编译完成\n> ${result.rawPath} → ${result.wikiPath}\n> 类型: ${result.wikiType}\n\n${insightsLine}${upgradeLine}🔗 需织入的页面:\n${linkedList || "  无"}\n\n⚠️ 请立即执行 obs-weave 更新关联页面。`,
          },
        ],
        details: result,
      };
    },
  });

  // ─── Tool: obs-weave ─────────────────────────────────────

  pi.registerTool({
    name: "obs_weave",
    label: "obs-weave: Weave into Existing Pages",
    description:
      "After obs-compile, update existing wiki pages with backlinks and experience log entries. " +
      "MUST be called after every obs-compile. " +
      "Triggers: after compile, 织入, weave.",
    parameters: Type.Object({
      rawPath: Type.String({ description: "Path to the raw session file that was compiled." }),
      wikiPath: Type.String({ description: "Path to the newly compiled wiki page." }),
      linkedTo: Type.Array(Type.String(), {
        description: "List of existing wiki pages to update (from obs-compile result).",
      }),
      insights: Type.Optional(
        Type.Array(Type.String(), { description: "Key insights to add as log entries." })
      ),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await weave(
        params.rawPath,
        params.wikiPath,
        params.linkedTo,
        params.insights ?? [],
        ctx
      );
      const updatedList =
        result.updatedPages.length > 0
          ? result.updatedPages.map((p) => `  ✅ ${p}`).join("\n")
          : "  无页面更新";
      const errorList =
        result.errors.length > 0
          ? `\n\n⚠️ 错误:\n${result.errors.map((e) => `  - ${e}`).join("\n")}`
          : "";
      return {
        content: [
          {
            type: "text",
            text: `🧵 obs-weave 完成\n\n已更新页面:\n${updatedList}${errorList}`,
          },
        ],
        details: result,
      };
    },
  });

  // ─── Tool: obs-lint ──────────────────────────────────────

  pi.registerTool({
    name: "obs_lint",
    label: "obs-lint: Knowledge Base Health Check",
    description:
      "Run a health check on the LLM-Wiki: detect orphan nodes, stale content, broken links, missing frontmatter. " +
      "Set fix=true to auto-mark stale pages with status: stale. " +
      "Triggers: after compile+weave, or user says 检查, lint, 健康检查.",
    parameters: Type.Object({
      fix: Type.Optional(
        Type.Boolean({ description: "Auto-mark stale pages with status: stale in frontmatter. Default: false." })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await lint(ctx, { fix: params.fix });
      const summary = [
        `📊 LLM-Wiki 健康检查`,
        ``,
        `| 级别 | 数量 |`,
        `|------|------|`,
        `| 🔴 错误 | ${result.summary.errors} |`,
        `| 🟡 警告 | ${result.summary.warnings} |`,
        `| 🔵 信息 | ${result.summary.info} |`,
        `| **总计** | **${result.summary.total}** |`,
        ``,
      ].join("\n");

      if (result.issues.length === 0) {
        return {
          content: [{ type: "text", text: `${summary}\n✅ 知识库健康，无问题。` }],
          details: result,
        };
      }

      const fixSection =
        result.fixed && result.fixed.length > 0
          ? `\n🔧 已自动修复 ${result.fixed.length} 个过期页面（标记 status: stale）:\n${result.fixed.map((p) => `  - ${p}`).join("\n")}\n`
          : "";

      const issueList = result.issues
        .slice(0, 10)
        .map((i) => {
          const emoji = i.severity === "error" ? "🔴" : i.severity === "warning" ? "🟡" : "🔵";
          return `${emoji} ${i.path}: ${i.message}`;
        })
        .join("\n");

      return {
        content: [{ type: "text", text: `${summary}\n${fixSection}${issueList}${result.issues.length > 10 ? `\n\n... 还有 ${result.issues.length - 10} 个问题` : ""}` }],
        details: result,
      };
    },
  });

  // ─── Tool: obs-capture ───────────────────────────────────

  pi.registerTool({
    name: "obs_capture",
    label: "obs-capture: Capture Insight to Wiki",
    description:
      "Save a key insight or discovery found during obs-query back into the wiki. " +
      "Prevents knowledge from disappearing into chat history. " +
      "Triggers: when obs-query finds something valuable, or user says 记下来, capture.",
    parameters: Type.Object({
      title: Type.String({ description: "Title for the captured page." }),
      content: Type.String({ description: "Markdown content of the insight." }),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Tags for categorization." })),
      wikiType: Type.Optional(
        Type.String({ description: "Wiki category: 概念, 发现, 决策, 命令, 项目. Default: 发现." })
      ),
      relatedPages: Type.Optional(
        Type.Array(Type.String(), { description: "Related wiki pages to link." })
      ),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await capture(
        params.title,
        params.content,
        { tags: params.tags, wikiType: params.wikiType, relatedPages: params.relatedPages },
        ctx
      );
      return {
        content: [
          {
            type: "text",
            text: `💾 ${result.action === "created" ? "已保存新发现" : "已更新"} 到 LLM-Wiki\n> ${result.path}`,
          },
        ],
        details: result,
      };
    },
  });

  // ─── Tool: obs-reference ─────────────────────────────────

  pi.registerTool({
    name: "obs_reference",
    label: "obs-reference: Cross-Vault Reference",
    description:
      "Create a cross-vault knowledge reference card. Does NOT copy source content — just records location and context. " +
      "Supported vaults: Works, MemPalace. " +
      "Triggers: when referencing knowledge from external Obsidian vaults.",
    parameters: Type.Object({
      sourceVault: Type.String({
        description: "Source vault name: 'Works' or 'MemPalace'.",
      }),
      sourcePath: Type.String({
        description: "Path to the note in the source vault, e.g. '概念/Pi扩展.md'.",
      }),
      note: Type.String({ description: "Why this reference is relevant; context notes." }),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Tags for categorization." })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await reference(
        params.sourceVault,
        params.sourcePath,
        params.note,
        { tags: params.tags },
        ctx
      );
      return {
        content: [
          {
            type: "text",
            text:
              `📎 已创建跨库引用\n> ${result.path}\n> 来源: ${result.source.vault}/${result.source.path}`,
          },
        ],
        details: result,
      };
    },
  });

  // ─── Tool: obs-aggregate ─────────────────────────────────

  pi.registerTool({
    name: "obs_aggregate",
    label: "obs-aggregate: Quarterly Knowledge Aggregation",
    description:
      "Aggregate compiled wiki pages from a quarter into wiki/记忆/YYYY/Qn.md. " +
      "Extracts key themes and source pages. " +
      "Triggers: quarterly review, 季度聚合, aggregate.",
    parameters: Type.Object({
      year: Type.Number({ description: "Year, e.g. 2026." }),
      quarter: Type.Number({ description: "Quarter: 1-4." }),
      project: Type.Optional(Type.String({ description: "Optional: specific project to aggregate." })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await aggregate(
        { year: params.year, quarter: params.quarter, project: params.project },
        ctx
      );
      if (!result) {
        return {
          content: [{ type: "text", text: `📭 ${params.year} Q${params.quarter} 无编译页面可聚合。` }],
          details: null,
        };
      }
      return {
        content: [
          {
            type: "text",
            text:
              `📚 ${params.year} Q${params.quarter} 季度聚合完成\n> ${result.outputPath}\n> ${result.pageCount} 个页面\n> ${result.keyThemes.length} 个关键主题\n\n${result.keyThemes.slice(0, 5).map((t) => `  - ${t}`).join("\n")}`,
          },
        ],
        details: result,
      };
    },
  });

  // ─── Tool: obs-distill ───────────────────────────────────

  pi.registerTool({
    name: "obs_distill",
    label: "obs-distill: Distill Experience Logs",
    description:
      "Distill the ## 📋 经验日志 section of a wiki page into a narrative summary, then clear the log. " +
      "Per schema Rule 7: convergent distillation (monthly). " +
      "Triggers: when experience log is too long, 蒸馏, distill.",
    parameters: Type.Object({
      pagePath: Type.String({ description: "Path to the wiki page, e.g. 'wiki/发现/agent-自动记录兜底机制.md'." }),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await distill(params.pagePath, ctx);
      if (!result) {
        return {
          content: [{ type: "text", text: `📭 ${params.pagePath} 无经验日志可蒸馏。` }],
          details: null,
        };
      }
      return {
        content: [
          {
            type: "text",
            text:
              `⚗️ 蒸馏完成\n> ${result.pagePath}\n> ${result.logCount} 条经验日志 → 摘要\n\n${result.summary.slice(0, 500)}`,
          },
        ],
        details: result,
      };
    },
  });
}
