/**
 * pi-llm-wiki — obs-reference tool.
 * Creates cross-vault knowledge reference cards (does not copy source).
 * References knowledge from external Obsidian vaults (Works, MemPalace, etc.)
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { writeFile } from "../client";

export interface ReferenceResult {
  path: string;
  source: { vault: string; path: string; permalink?: string };
}

/** Known external vaults */
const EXTERNAL_VAULTS: Record<string, { api: string; path: string }> = {
  Works: { api: "http://localhost:27123", path: "/mnt/d/DB/Obsidian/Works" },
  MemPalace: { api: "http://localhost:27124", path: "/mnt/d/DB/Obsidian/MemPalace" },
};

export async function reference(
  sourceVault: string,
  sourcePath: string,
  note: string,
  params: { tags?: string[] },
  ctx: ExtensionContext
): Promise<ReferenceResult> {
  const vaultConfig = EXTERNAL_VAULTS[sourceVault];
  if (!vaultConfig) {
    throw new Error(
      `Unknown vault: ${sourceVault}. Known: ${Object.keys(EXTERNAL_VAULTS).join(", ")}`
    );
  }

  const title = sourcePath.split("/").pop()?.replace(".md", "") ?? "reference";
  const date = new Date().toISOString().split("T")[0];
  const safeName = `ref-${sourceVault}-${title.replace(/[/\\?%*:|"<>]/g, "-").slice(0, 60)}`;
  const filePath = `wiki/引用/${safeName}.md`;

  const tagList = [...(params.tags ?? []), "reference", sourceVault.toLowerCase()];

  const pageContent = `---
title: "📎 ${title}"
tags: [${tagList.join(", ")}]
type: "引用"
source_vault: "${sourceVault}"
source_path: "${sourcePath}"
date: ${date}
---

# 📎 ${title}

> **跨库引用** — 此页不复制原文，仅记录位置和上下文。

| 属性 | 值 |
|------|-----|
| 来源仓库 | ${sourceVault} |
| 路径 | \`${sourcePath}\` |
| 创建日期 | ${date} |

## 笔记

${note}

---

> 由 obs-reference 创建。用 Obsidian 打开 [[${sourcePath}|${sourceVault}/${sourcePath}]] 查看原文。
`;

  await writeFile(filePath, pageContent);

  return {
    path: filePath,
    source: {
      vault: sourceVault,
      path: sourcePath,
    },
  };
}
