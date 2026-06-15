/**
 * pi-llm-wiki — obs_rate tool.
 * Active feedback mechanism: agent can rate wiki pages as useful/outdated.
 * Quality_score adjusts accordingly, driving the feedback loop.
 */

import { readFile, writeFile } from "../client";
import { parseFrontmatter } from "../system/parse";
import { updateFrontmatter } from "../manifest";
import { updatePageQuality } from "./quality";

export interface RateResult {
  path: string;
  rating: "useful" | "outdated";
  quality_score: number;
  message: string;
}

/**
 * Rate a wiki page.
 * @param path - vault-relative path (e.g. "wiki/发现/foo.md")
 * @param rating - "useful" (knowledge helped) or "outdated" (knowledge is stale/wrong)
 */
export function ratePage(path: string, rating: "useful" | "outdated"): RateResult | null {
  try {
    const content = readFile(path);
    const fm = parseFrontmatter(content);

    if (rating === "useful") {
      // Increment queried_count as positive signal
      const current = typeof fm.queried_count === "number" ? fm.queried_count
        : typeof fm.queried_count === "string" ? parseInt(fm.queried_count, 10) : 0;
      const updated = updateFrontmatter(content, {
        queried_count: current + 1,
        last_queried: new Date().toISOString().split("T")[0],
        rated_useful: (typeof fm.rated_useful === "number" ? fm.rated_useful : 0) + 1,
      });
      writeFile(path, updated);
    } else {
      // Mark as stale — quality_score will be suppressed by quality gate
      const updated = updateFrontmatter(content, {
        status: "stale",
        rated_outdated: (typeof fm.rated_outdated === "number" ? fm.rated_outdated : 0) + 1,
      });
      writeFile(path, updated);
    }

    // Recalculate quality_score
    const qInfo = updatePageQuality(path);
    return {
      path,
      rating,
      quality_score: qInfo?.quality_score ?? 3,
      message: rating === "useful"
        ? "已记录为有用，quality_score 已更新"
        : "已标记为过期，quality_score 已下调",
    };
  } catch (e: any) {
    return null;
  }
}
