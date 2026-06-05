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
    // Check AGENTS.md first (Pi-specific)
    const agentsPath = path.join(dir, "AGENTS.md");
    if (fs.existsSync(agentsPath)) {
      const name = path.basename(dir);
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
  return { name: path.basename(cwd), root: cwd, source: "package.json" };
}
