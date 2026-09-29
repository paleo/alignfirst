import { CliError } from "../cli-error.js";
import { parseArgs } from "node:util";
import type { CommandContext } from "../context.js";
import { parseCommandArgs } from "../parse-args.js";
import {
  type ProjectConfig,
  resolveProjectConfig,
  type ResolvedProjectConfig,
} from "../project-config.js";
import {
  type CompanionLayout,
  ITEM_NAMES,
  type ItemLocation,
  type ItemName,
  layoutOf,
  type ProjectLayout,
  renderItemLocation,
} from "../project-layout.js";
import { cliRangeResult } from "../version-guard.js";

interface ConfigReport {
  source: "project" | "companion" | null;
  cli: CliReport | null;
  config: ProjectConfig | null;
  companion: CompanionLayout | null;
  locations: Record<ItemName, ItemLocation>;
}

interface CliReport {
  installed: string;
  range: string;
  satisfied: boolean;
}

export function runConfig(ctx: CommandContext, args: string[]): number {
  const usage = `Usage: ${ctx.form} config [--json]\n`;
  const json = parseConfigArgs(ctx, args, usage);
  if (json === undefined) return 0;
  const layout = layoutOf(ctx);
  const report = buildConfigReport(ctx, layout, resolveProjectConfig(layout));
  ctx.stdout.write(json ? `${JSON.stringify(report, undefined, 2)}\n` : renderConfigReport(report));
  return 0;
}

function parseConfigArgs(ctx: CommandContext, args: string[], usage: string): boolean | undefined {
  const { values, positionals } = parseCommandArgs(usage, () =>
    parseArgs({
      args,
      options: {
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: true,
    } as const),
  );
  if (values.help) {
    ctx.stdout.write(usage);
    return;
  }
  if (positionals.length > 0)
    throw new CliError(`Unexpected argument: ${positionals[0]}\n\n${usage}`);
  return values.json;
}

function buildConfigReport(
  ctx: CommandContext,
  layout: ProjectLayout,
  resolved: ResolvedProjectConfig | undefined,
): ConfigReport {
  const cli = cliRangeResult(resolved?.config, ctx.version);
  return {
    source: resolved?.source ?? null,
    cli: cli ? { installed: ctx.version, range: cli.range, satisfied: cli.satisfied } : null,
    config: resolved?.config ?? null,
    companion: layout.companion,
    locations: layout.locations,
  };
}

function renderConfigReport(report: ConfigReport): string {
  const lines = [`Source: ${report.source ?? "none"}`];
  if (report.cli)
    lines.push(
      `CLI range: ${report.cli.range}, ${report.cli.satisfied ? "satisfied" : "not satisfied"} by ${report.cli.installed}`,
    );
  else lines.push("CLI range: none");
  lines.push(renderCompanionLine(report.companion));
  for (const name of ITEM_NAMES) lines.push(renderItemLocation(name, report.locations[name]));
  if (report.config) lines.push("Config:", JSON.stringify(report.config, undefined, 2));
  return `${lines.join("\n")}\n`;
}

function renderCompanionLine(companion: CompanionLayout | null): string {
  if (companion === null) return "Companion: none";
  return `Companion: ${companion.dir}${companion.exists ? "" : " (missing)"}`;
}
