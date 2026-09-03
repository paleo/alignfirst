import { CliError } from "../cli-error.js";
import { parseArgs } from "node:util";
import type { CommandContext } from "../context.js";
import { resolveProjectConfig, type ResolvedProjectConfig } from "../overlay.js";
import { parseCommandArgs } from "../parse-args.js";
import { cliRangeResult } from "../version-guard.js";

interface ConfigReport {
  source: "root" | "overlay" | null;
  overlay: OverlayReport | null;
  cli: CliReport | null;
  config: ResolvedProjectConfig["config"] | null;
}

interface OverlayReport {
  dir: string;
  matchedBy: "remote" | "paths";
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
  const resolved = resolveProjectConfig(ctx.cwd, ctx.env, ctx.home);
  const report = buildConfigReport(ctx, resolved);
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
  resolved: ResolvedProjectConfig | undefined,
): ConfigReport {
  const overlay = resolved?.overlay;
  const cli = cliRangeResult(resolved?.config, ctx.version);
  return {
    source: resolved?.source ?? null,
    overlay: overlay ? { dir: overlay.dir, matchedBy: overlay.matchedBy } : null,
    cli: cli ? { installed: ctx.version, range: cli.range, satisfied: cli.satisfied } : null,
    config: resolved?.config ?? null,
  };
}

function renderConfigReport(report: ConfigReport): string {
  const lines = [`Source: ${report.source ?? "none"}`];
  if (report.overlay)
    lines.push(`Overlay: ${report.overlay.dir} (matched by ${report.overlay.matchedBy})`);
  if (report.cli)
    lines.push(
      `CLI range: ${report.cli.range}, ${report.cli.satisfied ? "satisfied" : "not satisfied"} by ${report.cli.installed}`,
    );
  else lines.push("CLI range: none");
  if (report.config) lines.push("Config:", JSON.stringify(report.config, undefined, 2));
  return `${lines.join("\n")}\n`;
}
