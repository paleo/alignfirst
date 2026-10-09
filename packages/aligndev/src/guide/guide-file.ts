import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { readProjectReport } from "../project/layout.js";
import type { ProjectsCallerContext } from "../project/project-cli.js";
import type { GuideFileCondition } from "./render-template.js";

// The project's guide file for the coding-agent assistant, resolved from PROJECT_PATH, the main
// worktree of the working directory: its `DEVELOPERS.md`, else its `README.md`, else none.
export function resolveGuideFile(ctx: ProjectsCallerContext): GuideFileCondition {
  const projectPath = mainWorktree(ctx);
  if (projectPath === undefined) return "noGuide";
  const report = readProjectReport(ctx.alignfirstCommand, projectPath, ctx.env);
  if ("error" in report) throw new Error(report.error);
  if (report.locations["DEVELOPERS.md"].exists) return "developers";
  return existsSync(join(projectPath, "README.md")) ? "readme" : "noGuide";
}

function mainWorktree(ctx: ProjectsCallerContext): string | undefined {
  try {
    const commonDir = execFileSync(
      "git",
      ["-C", ctx.cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf8", env: ctx.env, stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return dirname(commonDir);
  } catch {
    return;
  }
}
