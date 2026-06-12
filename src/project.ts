/**
 * pi-llm-wiki — Project detection helper.
 * Walks up from cwd to find AGENTS.md or package.json to identify the current project.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface ProjectInfo {
  name: string;
  root: string;
  source: "AGENTS.md" | "package.json";
}

/** Detect the current project from cwd by walking upward */
export function detectProject(cwd: string): ProjectInfo | null {
  let dir = cwd;
  const home = process.env.HOME || "/home";

  while (dir !== "/" && dir.startsWith(home)) {
    // Check AGENTS.md first (Pi-specific) — extract project name from title
    const agentsPath = path.join(dir, "AGENTS.md");
    if (fs.existsSync(agentsPath)) {
      const content = fs.readFileSync(agentsPath, "utf-8");
      const titleMatch = content.match(/^#\s+(.+)$/m);
      const name = titleMatch?.[1]?.replace(/\s+/g, "-") ?? path.basename(dir);
      return { name, root: dir, source: "AGENTS.md" };
    }

    // Fallback: package.json
    const pkgPath = path.join(dir, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        return { name: pkg.name ?? path.basename(dir), root: dir, source: "package.json" };
      } catch {
        return { name: path.basename(dir), root: dir, source: "package.json" };
      }
    }

    dir = path.dirname(dir);
  }

  // Default: use directory name
  let name = path.basename(cwd);
  // Clean up path-encoded names from crash recovery (e.g. "_home_wtown_projects_pi_" → "pi")
  // These occur when cwd is encoded as a file-system-safe path like "_home_wtown_projects_pi_"
  const parts = name.split("_");
  const meaningful = parts.filter((p) => p && p.length > 1 && !["home", "mnt", "projects", "modules", "dotfiles", "tmp", "Users"].includes(p));
  if (meaningful.length > 0 && meaningful.length < parts.length) {
    name = meaningful[meaningful.length - 1]; // Use the last meaningful segment
  }
  return { name, root: cwd, source: "package.json" };
}
