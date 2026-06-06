/**
 * pi-llm-wiki — obs-capture tool.
 * Captures key insights discovered during obs-query back into the wiki.
 * Prevents knowledge from disappearing into chat history.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { writeFile, exists } from "../client";
import { detectProject } from "../project";

export interface CaptureResult {
  path: string;
  action: "created" | "updated";
}

export async function capture(
  title: string,
  content: string,
  params: { tags?: string[]; wikiType?: string; relatedPages?: string[] },
  ctx: ExtensionContext
): Promise<CaptureResult> {
  const project = detectProject(ctx.cwd ?? process.cwd());
  const projectName = project?.name ?? "unknown";
  const wikiType = params.wikiType ?? "发现";
  const date = new Date().toISOString().split("T")[0];

  const safeName = title.replace(/[/\\?%*:|"<>]/g, "-").slice(0, 80);
  const wikiDir =
    wikiType === "项目"
      ? `wiki/项目/${projectName}`
      : `wiki/${wikiType}`;
  const filePath = `${wikiDir}/${safeName}.md`;

  const tagList = [...(params.tags ?? []), `wiki/${wikiType}`, "captured"];
  const relatedLine = params.relatedPages?.map((r) => `[[${r}]]`).join(", ") ?? "";

  const action: "created" | "updated" = (await exists(filePath)) ? "updated" : "created";

  const pageContent = `---
title: "${title}"
tags: [${tagList.join(", ")}]
type: "${wikiType}"
project: "${projectName}"
cssclasses: ["${wikiType}"]
date: ${date}
captured: ${date}
related: [${params.relatedPages?.join(", ") ?? ""}]
---

# ${title}

${content}

---

> 由 obs-capture 于 ${date} ${action === "created" ? "创建" : "更新"}
`;

  await writeFile(filePath, pageContent);
  return { path: filePath, action };
}
