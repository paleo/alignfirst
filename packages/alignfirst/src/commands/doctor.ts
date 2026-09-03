import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import semver from "semver";

import { CliError } from "../cli-error.js";
import type { CommandContext } from "../context.js";
import { errorMessage } from "../errors.js";
import { findExecutable } from "../executables.js";
import {
  findOverlay,
  resolveProjectConfig,
  resolveProjectFile,
  type ResolvedProjectConfig,
} from "../overlay.js";
import { parseCommandArgs } from "../parse-args.js";
import { resolvePlansMode } from "../plans/mode.js";
import { findInstalledSkill, STUB_SKILLS } from "../skills.js";
import { cliRangeResult } from "../version-guard.js";

const PROJECT_CONFIG_NAME = ".alignfirst.json";

interface DoctorLine {
  level: "ok" | "warn" | "error";
  text: string;
}

export function runDoctor(ctx: CommandContext, args: string[]): number {
  const usage = `Usage: ${ctx.form} doctor\n`;
  if (parseDoctorArgs(ctx, args, usage)) return 0;
  writeSection(ctx, "CLI", () => inspectCli(ctx));
  writeSection(ctx, "Config", () => inspectConfig(ctx));
  writeSection(ctx, "Plans", () => inspectPlans(ctx));
  writeSection(ctx, "Docmap", () => inspectDocmap(ctx));
  writeSection(ctx, "Skills", () => inspectSkills(ctx));
  writeSection(ctx, "Overlay", () => inspectOverlay(ctx));
  writeSection(ctx, "Companion", () => inspectCompanion(ctx));
  return 0;
}

function parseDoctorArgs(ctx: CommandContext, args: string[], usage: string): boolean {
  const { values, positionals } = parseCommandArgs(usage, () =>
    parseArgs({
      args,
      options: { help: { type: "boolean", short: "h", default: false } },
      strict: true,
      allowPositionals: true,
    } as const),
  );
  if (positionals.length > 0)
    throw new CliError(`Unexpected argument: ${positionals[0]}\n\n${usage}`);
  if (!values.help) return false;
  ctx.stdout.write(usage);
  return true;
}

function writeSection(ctx: CommandContext, section: string, inspect: () => DoctorLine[]): void {
  let lines: DoctorLine[];
  try {
    lines = inspect();
  } catch (error) {
    lines = [{ level: "error", text: firstLine(errorMessage(error)) }];
  }
  for (const line of lines) ctx.stdout.write(`[${line.level}] ${section}: ${line.text}\n`);
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0];
}

function inspectCli(ctx: CommandContext): DoctorLine[] {
  const invokedPath = process.argv[1] ?? fileURLToPath(import.meta.url);
  return [
    {
      level: "ok",
      text: `${ctx.version}, ${realpathSync(invokedPath)}, launched as ${ctx.form}`,
    },
  ];
}

function inspectConfig(ctx: CommandContext): DoctorLine[] {
  const resolved = resolveProjectConfig(ctx.cwd, ctx.env, ctx.home);
  const lines: DoctorLine[] = [{ level: "ok", text: `source ${configSource(resolved)}` }];
  const result = cliRangeResult(resolved?.config, ctx.version);
  if (result === undefined) {
    lines.push({ level: "ok", text: "no cli range" });
    return lines;
  }
  lines.push({
    level: result.satisfied ? "ok" : "error",
    text: `${result.satisfied ? "satisfies" : "does not satisfy"} ${result.range}`,
  });
  if (semver.gtr(ctx.version, result.range))
    lines.push({ level: "warn", text: `${ctx.version} is ahead of ${result.range}` });
  return lines;
}

function configSource(resolved: ResolvedProjectConfig | undefined): string {
  if (resolved === undefined) return "none";
  return resolved.source === "root" ? "root" : (resolved.overlay?.dir ?? "overlay");
}

function inspectPlans(ctx: CommandContext): DoctorLine[] {
  const mode = resolvePlansMode(ctx.cwd, ctx.form);
  return [
    {
      level: "ok",
      text: mode.kind === "shared" ? `shared (${mode.repoToplevel})` : "local",
    },
  ];
}

function inspectDocmap(ctx: CommandContext): DoctorLine[] {
  const overlay = findOverlay(ctx.cwd, ctx.env, ctx.home);
  const docs = resolveProjectFile(ctx.cwd, overlay, "docs");
  const source = docs?.source ?? "none";
  return [
    { level: docs === undefined ? "warn" : "ok", text: `docs/ source ${source}` },
    { level: "ok", text: `embedded docmap ${readDocmapVersion()}` },
  ];
}

function readDocmapVersion(): string {
  const require = createRequire(import.meta.url);
  const pkg: unknown = require("@paleo/docmap/package.json");
  if (!isRecord(pkg) || typeof pkg.version !== "string")
    throw new Error("@paleo/docmap package.json has no version");
  return pkg.version;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function inspectSkills(ctx: CommandContext): DoctorLine[] {
  return STUB_SKILLS.map((name) => {
    const installed = findInstalledSkill(ctx.home, name);
    if (installed === undefined) return { level: "warn", text: `${name} missing` };
    return {
      level: "ok",
      text: `${name} ${installed.version ?? "unknown"} (${installed.root})`,
    };
  });
}

function inspectOverlay(ctx: CommandContext): DoctorLine[] {
  const configured = ctx.env.ALIGNFIRST_OVERLAYS;
  if (configured === undefined || configured === "")
    return [{ level: "ok", text: "no overlays directory" }];
  const overlay = findOverlay(ctx.cwd, ctx.env, ctx.home);
  if (overlay === undefined) return [{ level: "ok", text: "no overlay matches" }];
  const lines: DoctorLine[] = [
    { level: "ok", text: `${overlay.dir} (matched by ${overlay.matchedBy})` },
  ];
  for (const name of [PROJECT_CONFIG_NAME, "AGENTS.md", "DEVELOPERS.md", "docs"])
    lines.push({
      level: "ok",
      text: `${name} ${resolveProjectFile(ctx.cwd, overlay, name)?.source ?? "none"}`,
    });
  return lines;
}

function inspectCompanion(ctx: CommandContext): DoctorLine[] {
  const executable = findExecutable(ctx.env, "alcode");
  if (executable === undefined)
    return [
      {
        level: "warn",
        text: "alcode not installed (optional; npm install -g @paleo/alcode)",
      },
    ];
  try {
    const version = execFileSync(executable, ["--version"], {
      encoding: "utf-8",
      env: ctx.env,
    }).trim();
    return [{ level: "ok", text: `alcode ${version} (${executable})` }];
  } catch (error) {
    return [{ level: "error", text: `alcode ${executable}: ${commandError(error)}` }];
  }
}

function commandError(error: unknown): string {
  if (isRecord(error) && typeof error.stderr === "string" && error.stderr !== "")
    return firstLine(error.stderr);
  return firstLine(errorMessage(error));
}
