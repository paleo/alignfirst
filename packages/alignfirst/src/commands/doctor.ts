import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import type { CommandContext } from "../context.js";
import { resolveDefaultBranch } from "../default-branch.js";
import { errorMessage } from "../errors.js";
import { parseBareCommandArgs } from "../parse-args.js";
import { resolvePlansMode } from "../plans/mode.js";
import { findStoppedRebase } from "../plans/rebase.js";
import {
  PROJECT_CONFIG_FILENAME,
  resolveProjectConfig,
  type ResolvedProjectConfig,
} from "../project-config.js";
import {
  type CompanionLayout,
  registryPath,
  sharedCompanionDirs,
  strayRegistryKeys,
  ITEM_NAMES,
  type ItemName,
  layoutOf,
  type ProjectLayout,
  renderItemLocation,
} from "../project-layout.js";
import { COMMAND_SKILLS, findInstalledSkill, type InstalledSkill } from "../skills.js";
import { cliRangeResult } from "../version-guard.js";
import { isAheadOfRange } from "../version-range.js";

interface DoctorLine {
  level: "ok" | "warn" | "error";
  text: string;
}

export function runDoctor(ctx: CommandContext, args: string[]): number {
  const usage = `Usage: ${ctx.form} doctor\n`;
  if (parseBareCommandArgs(ctx, args, usage)) return 0;
  writeSection(ctx, "CLI", () => inspectCli(ctx));
  let resolved: ResolvedProjectConfig | undefined;
  writeSection(ctx, PROJECT_CONFIG_FILENAME, () => {
    resolved = resolveProjectConfig(layoutOf(ctx));
    return inspectConfig(ctx, resolved);
  });
  writeSection(ctx, "Companion", () => inspectCompanion(ctx));
  writeSection(ctx, "Git", () => inspectGit(ctx, resolved));
  writeSection(ctx, "Work files", () => inspectPlans(ctx));
  writeSection(ctx, "Docmap", () => inspectDocmap(ctx));
  writeSection(ctx, "Skills", () => inspectSkills(ctx));
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
  const lines: DoctorLine[] = [{ level: "ok", text: resolved === undefined ? "none" : "present" }];
  const result = cliRangeResult(resolved?.config, ctx.version);
  if (result === undefined) {
    lines.push({ level: "ok", text: "no cli range" });
    return lines;
  }
  lines.push({
    level: result.satisfied ? "ok" : "error",
    text: `${result.satisfied ? "satisfies" : "does not satisfy"} ${result.range}`,
  });
  if (isAheadOfRange(ctx.version, result.range))
    lines.push({ level: "warn", text: `${ctx.version} is ahead of ${result.range}` });
  return lines;
}

function inspectCompanion(ctx: CommandContext): DoctorLine[] {
  const path = registryPath(ctx.home);
  const layout = layoutOf(ctx);
  const file: DoctorLine = {
    level: "ok",
    text: `registry ${existsSync(path) ? "valid" : "absent"} (${path})`,
  };
  const registryLines = [
    file,
    ...strayRegistryKeys(ctx.home).map(describeStrayKey),
    ...sharedCompanionDirs(ctx.home).map(describeSharedDir),
  ];
  if (layout.companion === null) return [...registryLines, { level: "ok", text: "none" }];
  const { companion } = layout;
  return [
    ...registryLines,
    { level: "ok", text: `key ${companion.key}` },
    { level: "ok", text: `directory ${companion.dir}${companion.exists ? "" : " (missing)"}` },
    ...ITEM_NAMES.map((name) => describeItem(name, layout, companion)),
  ];
}

function describeStrayKey(key: string): DoctorLine {
  return { level: "warn", text: `key ${key} names no git main worktree (ignored)` };
}

function describeSharedDir({ dir, keys }: { dir: string; keys: string[] }): DoctorLine {
  return { level: "warn", text: `keys ${keys.join(", ")} share the companion directory ${dir}` };
}

function describeItem(
  name: ItemName,
  layout: ProjectLayout,
  companion: CompanionLayout,
): DoctorLine {
  const location = layout.locations[name];
  const missingCopy = companion.flags[name] === true && !location.exists;
  return { level: missingCopy ? "warn" : "ok", text: renderItemLocation(name, location) };
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
  const mode = resolvePlansMode(ctx.cwd, layoutOf(ctx).locations[".plans"], ctx.form);
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
  const present = layoutOf(ctx).locations.docs.exists;
  return [
    { level: "ok", text: `docs/ ${present ? "present" : "none"}` },
    { level: "ok", text: `embedded docmap ${readDocmapVersion()}` },
  ];
}

function readDocmapVersion(): string {
  const require = createRequire(import.meta.url);
  const pkg: unknown = require("@alignfirst/docmap/package.json");
  if (!isRecord(pkg) || typeof pkg.version !== "string")
    throw new Error("@alignfirst/docmap package.json has no version");
  return pkg.version;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function inspectSkills(ctx: CommandContext): DoctorLine[] {
  const alignfirst = findInstalledSkill(ctx.home, "alignfirst");
  const alignfirstLine: DoctorLine =
    alignfirst === undefined
      ? { level: "ok", text: "alignfirst none" }
      : describeInstalledSkill("alignfirst", alignfirst);
  const commands = COMMAND_SKILLS.map((name) => ({
    name,
    installed: findInstalledSkill(ctx.home, name),
  }));
  if (commands.every(({ installed }) => installed === undefined))
    return [alignfirstLine, { level: "ok", text: "no command skill installed" }];
  return [alignfirstLine, ...commands.map(describeCommandSkill)];
}

interface CommandSkill {
  name: string;
  installed: InstalledSkill | undefined;
}

function describeCommandSkill({ name, installed }: CommandSkill): DoctorLine {
  if (installed === undefined) return { level: "warn", text: `${name} missing` };
  return describeInstalledSkill(name, installed);
}

function describeInstalledSkill(name: string, installed: InstalledSkill): DoctorLine {
  const version = installed.version ?? "unknown";
  const major = majorOf(installed.version);
  if (major === undefined || major < 4)
    return {
      level: "warn",
      text: `${name} ${version} predates v4; update: npx -y skills update --global --yes`,
    };
  return { level: "ok", text: `${name} ${version} (${installed.root})` };
}

function majorOf(version: string | undefined): number | undefined {
  if (version === undefined) return;
  const match = /^(\d+)\./.exec(version);
  return match === null ? undefined : Number(match[1]);
}
