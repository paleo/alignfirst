import { isAbsolute } from "node:path";

import { runAlignfirst } from "../alignfirst-cli.js";
import type { CommandForms } from "../command-form.js";
import { errorMessage } from "../errors.js";
import type { GitContext } from "../worktree/git.js";
import { type ProjectReport, readProjectReport } from "./layout.js";

export interface PlansContext extends GitContext {
  alignfirstCommand: string[];
  forms: CommandForms;
}

export function validateEffectivePlans(ctx: PlansContext): string {
  try {
    const result = runAlignfirst(
      ctx.alignfirstCommand,
      ["plans", "check", "--json"],
      ctx.cwd,
      ctx.env,
    );
    if (result.status !== 0) {
      const diagnostic = result.stderr.trimEnd();
      throw new Error(diagnostic === "" ? "alignfirst plans check failed" : diagnostic);
    }
    let value: unknown;
    try {
      value = JSON.parse(result.stdout);
    } catch {
      throw new Error(`Invalid alignfirst plans check JSON report for ${ctx.cwd}`);
    }
    if (
      !isRecord(value) ||
      !isRecord(value.plans) ||
      typeof value.plans.target !== "string" ||
      value.plans.target.trim().length === 0 ||
      !isAbsolute(value.plans.target)
    ) {
      throw new Error(`Invalid alignfirst plans check report for ${ctx.cwd}`);
    }
    return value.plans.target;
  } catch (error) {
    throw new Error(
      `${errorMessage(error)}\nSee \`${ctx.forms.aligndev} guide work-files-setup\` for authorized preparation.`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function readReport(ctx: PlansContext): ProjectReport {
  const report = readProjectReport(ctx.alignfirstCommand, ctx.cwd, ctx.env);
  if ("error" in report) throw new Error(report.error);
  return report;
}
