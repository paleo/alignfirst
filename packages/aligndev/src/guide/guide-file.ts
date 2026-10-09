import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { readProjectReport } from "../project/layout.js";
import type { ProjectsCallerContext } from "../project/project-cli.js";
import type { GuideFileCondition } from "./render-template.js";

// The project's guide file for the coding-agent assistant: its `DEVELOPERS.md`, else the
// `README.md` at the root of the working directory's repository, else none.
export function resolveGuideFile(ctx: ProjectsCallerContext): GuideFileCondition {
  const report = readProjectReport(ctx.alignfirstCommand, ctx.cwd, ctx.env);
  if ("error" in report) throw new Error(report.error);
  if (report.locations["DEVELOPERS.md"].exists) return "developers";
  const root = repositoryRoot(ctx);
  if (root === undefined) return "noGuide";
  return existsSync(join(root, "README.md")) ? "readme" : "noGuide";
}

function repositoryRoot(ctx: ProjectsCallerContext): string | undefined {
  try {
    return execFileSync("git", ["-C", ctx.cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      env: ctx.env,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return;
  }
}
