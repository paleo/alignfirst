import type { WorkspaceConfigReport } from "@alignfirst/workspace/config";
import { CliError } from "../cli-error.js";
import { parseArgs } from "node:util";
import type { CommandContext } from "../context.js";
import { parseCommandArgs } from "../parse-args.js";
import { resolveProjectConfig } from "../project-config.js";
import type { ProjectConfig, ResolvedProjectConfig } from "../project-config-types.js";
import {
  type AligndevProjectSettings,
  type CompanionLayout,
  ITEM_NAMES,
  type ProjectLocations,
  type SelectionOrigin,
  type ItemName,
  layoutOf,
  type ProjectLayout,
  renderItemLocation,
} from "../project-layout.js";

interface ConfigReport {
  source: "project" | "companion" | null;
  workspace: WorkspaceConfigReport;
  config: ProjectConfig | null;
  companion: CompanionLayout | null;
  aligndev: AligndevProjectSettings | null;
  locations: ProjectLocations;
  selectionOrigins: Record<ItemName, SelectionOrigin>;
}

export function runConfig(ctx: CommandContext, args: string[]): number {
  const usage = `Usage: ${ctx.form} config [--json]\n`;
  const json = parseConfigArgs(ctx, args, usage);
  if (json === undefined) return 0;
  const layout = layoutOf(ctx);
  const resolved = resolveProjectConfig(layout);
  const report = buildConfigReport(layout, resolved);
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
  layout: ProjectLayout,
  resolved: ResolvedProjectConfig | undefined,
): ConfigReport {
  const ports = resolved?.config.devServer?.ports;
  const workspace: WorkspaceConfigReport = {
    location: layout.locations.alignfirst,
    schemaVersion: resolved?.config.schemaVersion ?? null,
    portRange: ports === undefined ? null : { first: ports.first, last: ports.last },
    hasDevServer: resolved?.config.devServer !== undefined,
    registryDir: layout.storage.registryDir,
    runtimeDir: layout.storage.runtimeDir,
  };
  return {
    source: resolved?.source ?? null,
    workspace,
    config: resolved?.config ?? null,
    companion: layout.companion,
    aligndev: layout.aligndev,
    locations: layout.locations,
    selectionOrigins: layout.selectionOrigins,
  };
}

function renderConfigReport(report: ConfigReport): string {
  const lines = [`Source: ${report.source ?? "none"}`];
  lines.push(
    `Workspace: ${report.workspace.location.path}${report.workspace.location.exists ? "" : " (missing)"}`,
    `Registry: ${report.workspace.registryDir}`,
    `Runtime: ${report.workspace.runtimeDir}`,
  );
  lines.push(...renderCompanionLines(report.companion));
  lines.push(`AlignDev profile: ${report.aligndev?.profile ?? "none"}`);
  for (const name of ITEM_NAMES)
    lines.push(
      `${renderItemLocation(name, report.locations[name])} [${report.selectionOrigins[name]}]`,
    );
  if (report.config) lines.push("Config:", JSON.stringify(report.config, undefined, 2));
  return `${lines.join("\n")}\n`;
}

function renderCompanionLines(companion: CompanionLayout | null): string[] {
  if (companion === null) return ["Companion: none"];
  return [
    `Companion: ${companion.dir}${companion.exists ? "" : " (missing)"}`,
    `Companion default: ${companion.defaultLocation}`,
    `Companion items: ${renderItemSettings(companion)}`,
  ];
}

/** The settings other than `"auto"`. */
function renderItemSettings({ items }: CompanionLayout): string {
  const set = ITEM_NAMES.filter((name) => items[name] !== "auto");
  if (set.length === 0) return "all auto";
  return set.map((name) => `${JSON.stringify(name)}: ${JSON.stringify(items[name])}`).join(", ");
}
