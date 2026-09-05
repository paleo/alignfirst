import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import semver from "semver";

import type { CommandContext } from "../context.js";
import { resolveDefaultBranch } from "../default-branch.js";
import { errorMessage } from "../errors.js";
import { findExecutable } from "../executables.js";
import { parseBareCommandArgs } from "../parse-args.js";
import { resolvePlansMode } from "../plans/mode.js";
import { findStoppedRebase } from "../plans/rebase.js";
import { resolveProjectConfig, type ResolvedProjectConfig } from "../project-config.js";
import { findInstalledSkill, STUB_SKILLS } from "../skills.js";
import { cliRangeResult } from "../version-guard.js";

interface DoctorLine {
  level: "ok" | "warn" | "error";
  text: string;
}

export function runDoctor(ctx: CommandContext, args: string[]): number {
  const usage = `Usage: ${ctx.form} doctor\n`;
  if (parseBareCommandArgs(ctx, args, usage)) return 0;
  writeSection(ctx, "CLI", () => inspectCli(ctx));
  let resolved: ResolvedProjectConfig | undefined;
  writeSection(ctx, "Config", () => {
    resolved = resolveProjectConfig(ctx.cwd);
    return inspectConfig(ctx, resolved);
  });
  writeSection(ctx, "Git", () => inspectGit(ctx, resolved));
  writeSection(ctx, "Plans", () => inspectPlans(ctx));
  writeSection(ctx, "Docmap", () => inspectDocmap(ctx));
  writeSection(ctx, "Skills", () => inspectSkills(ctx));
  writeSection(ctx, "Companion", () => inspectCompanion(ctx));
  return 0;
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

function inspectConfig(
  ctx: CommandContext,
  resolved: ResolvedProjectConfig | undefined,
): DoctorLine[] {
  const lines: DoctorLine[] = [{ level: "ok", text: resolved?.source ?? "none" }];
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

function inspectGit(
  ctx: CommandContext,
  resolved: ResolvedProjectConfig | undefined,
): DoctorLine[] {
  const branch = resolveDefaultBranch(ctx.cwd, resolved?.config);
  if (branch === undefined) return [{ level: "warn", text: "default branch unresolved" }];
  const source = branch.source === "config" ? "git.defaultBranch" : `cached ${branch.remote}/HEAD`;
  return [{ level: "ok", text: `default branch ${branch.name} (${source})` }];
}

function inspectPlans(ctx: CommandContext): DoctorLine[] {
  const mode = resolvePlansMode(ctx.cwd, ctx.form);
  if (mode.kind === "shared" && findStoppedRebase(mode.repoToplevel) !== undefined)
    return [{ level: "error", text: `rebase stopped on a conflict in ${mode.repoToplevel}` }];
  return [
    {
      level: "ok",
      text: mode.kind === "shared" ? `shared (${mode.repoToplevel})` : "local",
    },
  ];
}

function inspectDocmap(ctx: CommandContext): DoctorLine[] {
  const present = existsSync(join(ctx.cwd, "docs"));
  return [
    { level: "ok", text: `docs/ ${present ? "present" : "none"}` },
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
    const version = installed.version ?? "unknown";
    const parsed = semver.parse(installed.version);
    if (parsed === null || parsed.major < 4)
      return {
        level: "warn",
        text: `${name} ${version} predates v4; update: npx -y skills update --global --yes`,
      };
    return { level: "ok", text: `${name} ${version} (${installed.root})` };
  });
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
