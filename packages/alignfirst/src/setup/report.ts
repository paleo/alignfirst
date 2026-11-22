import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { CliError } from "../cli-error.js";
import type { CommandContext } from "../context.js";
import { resolveDefaultBranch } from "../default-branch.js";
import { errorMessage } from "../errors.js";
import {
  gitOutput,
  gitOutputOrUndefined,
  gitSucceeds,
  linkedMainWorktree,
  optionalRepositoryId,
} from "../git.js";
import { inspectGlobalSkills } from "../inspection.js";
import { isPlainObject } from "../json-shape.js";
import { assertPlansNotProjectTracked } from "../plans/layout.js";
import { resolvePlansMode } from "../plans/mode.js";
import type { ProjectConfig } from "../project-config-types.js";
import { layoutOf, projectRoot, registryPath } from "../project-layout.js";
import { findInstalledSkill, resolveSkillRoots } from "../skills.js";
import {
  describeInstructions,
  describeLegacySections,
  inspectInstructions,
} from "./instruction-status.js";

const LOCKFILES = [
  ["package-lock.json", "npm"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
] as const;
const PASEO_SKILL = "paseo-alignfirst-workspace";

interface LegacySignal {
  signal: string;
  topic: string;
}

/** Read-only. A detection that throws prints its first error line and the report continues. */
export function writeStateReport(ctx: CommandContext): void {
  const root = projectRoot(ctx.cwd);
  ctx.stdout.write("# Project state\n\n");
  writeItem(ctx, "Git", () => inspectGitState(ctx));
  writeItem(ctx, "Instructions", () => inspectInstructionState(ctx));
  writeItem(ctx, "Configuration", () => inspectConfiguration(ctx));
  writeItem(ctx, "Companion", () => inspectCompanionState(ctx));
  writeItem(ctx, "Work files", () => inspectWorkFiles(ctx, root));
  writeItem(ctx, "Docmap", () => inspectDocs(ctx));
  writeItem(ctx, "Workspace", () => inspectWorkspace(ctx, root));
  writeItem(ctx, "Package manager", () => [detectPackageManager(root)]);
  writeItem(ctx, "Conventions", () => inspectConventions(ctx, root));
  writeItem(ctx, "Legacy", () => inspectLegacy(ctx, root));
  writeItem(ctx, "Global skills", () => inspectSkillsState(ctx));
  writeItem(ctx, "Paseo", () => inspectPaseo(root));
}

/** The first line follows the item name; the others are nested bullets. */
function writeItem(ctx: CommandContext, item: string, inspect: () => string[]): void {
  let lines: string[];
  try {
    lines = inspect();
  } catch (error) {
    lines = [errorMessage(error).split("\n", 1)[0]];
  }
  const [text, ...details] = lines;
  ctx.stdout.write(`- ${item}: ${text}\n`);
  for (const detail of details) ctx.stdout.write(`  - ${detail}\n`);
}

function inspectGitState(ctx: CommandContext): string[] {
  if (optionalRepositoryId(ctx.cwd) === undefined) return ["not a repository"];
  const linked = linkedMainWorktree(ctx.cwd);
  const worktree = linked === undefined ? "main worktree" : `linked worktree of ${linked}`;
  const tree = gitOutput(ctx.cwd, "status", "--porcelain") === "" ? "clean" : "dirty";
  const branch = resolveDefaultBranch(ctx.cwd, readableConfig(ctx));
  return [`${worktree}, ${tree} working tree, default branch ${branch?.name ?? "unresolved"}`];
}

/** The configuration when it resolves; the Configuration item reports an invalid one. */
function readableConfig(ctx: CommandContext): ProjectConfig | undefined {
  try {
    return layoutOf(ctx).projectConfig?.config;
  } catch {
    return;
  }
}

function inspectInstructionState(ctx: CommandContext): string[] {
  const report = inspectInstructions(ctx);
  return [describeInstructions(ctx, report), ...describeLegacySections(ctx, report)];
}

function inspectConfiguration(ctx: CommandContext): string[] {
  const { path, in: source, exists } = layoutOf(ctx).locations.alignfirst;
  return [exists ? `${path} (${source})` : `absent (would be created at ${path})`];
}

function inspectCompanionState(ctx: CommandContext): string[] {
  const { companion } = layoutOf(ctx);
  if (companion === null) return ["none"];
  const missing = companion.exists ? "" : ", missing";
  return [`${companion.dir} (defaultLocation ${companion.defaultLocation}${missing})`];
}

function inspectWorkFiles(ctx: CommandContext, root: string): string[] {
  const plans = layoutOf(ctx).locations[".plans"];
  if (!plans.exists) return [`missing (${plans.path})`];
  try {
    assertPlansNotProjectTracked(ctx.cwd, plans, ctx.form);
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    return [`project-tracked (${plans.path})`];
  }
  const mode = resolvePlansMode(ctx.cwd, plans, ctx.form, ctx.home);
  if (mode.kind === "shared") return [`shared with the clone ${mode.repoToplevel}`];
  if (plans.in === "companion") return [`local, in the companion (${plans.path})`];
  return [`local (${plans.path}), ${ignoreState(root, ".plans")}`];
}

function ignoreState(root: string, path: string): string {
  return gitSucceeds(root, "check-ignore", "-q", "--", path) ? "ignored" : "not ignored";
}

function inspectDocs(ctx: CommandContext): string[] {
  const docs = layoutOf(ctx).locations.docs;
  return [docs.exists ? `docs/ present (${docs.path})` : "docs/ absent"];
}

function inspectWorkspace(ctx: CommandContext, root: string): string[] {
  const layout = layoutOf(ctx);
  const config = layout.projectConfig?.config;
  const declared = config?.workspace !== undefined || config?.devServer !== undefined;
  const facts = [declared ? "recipe declared" : "no recipe"];
  if (layout.storage.in === "project") facts.push(`.local-wt/ ${ignoreState(root, ".local-wt/")}`);
  if (existsSync(join(root, ".local"))) {
    const listed = config?.workspace?.sharedDirs?.includes(".local") === true;
    facts.push(
      `.local/ ${ignoreState(root, ".local/")}, ${listed ? "listed" : "not listed"} in workspace.sharedDirs`,
    );
  }
  return [facts.join("; ")];
}

function detectPackageManager(root: string): string {
  const manifest = readPackageJson(root);
  if (manifest === undefined) return "none";
  if (typeof manifest.packageManager === "string")
    return `${manifest.packageManager} (packageManager)`;
  const lockfile = LOCKFILES.find(([file]) => existsSync(join(root, file)));
  if (lockfile !== undefined) return `${lockfile[1]} (${lockfile[0]})`;
  return "npm (no lockfile)";
}

function readPackageJson(root: string): Record<string, unknown> | undefined {
  const path = join(root, "package.json");
  if (!existsSync(path)) return;
  const value: unknown = JSON.parse(readFileSync(path, "utf-8"));
  if (!isPlainObject(value)) throw new CliError(`${path} is not a JSON object.`);
  return value;
}

function inspectConventions(ctx: CommandContext, root: string): string[] {
  if (layoutOf(ctx).projectConfig?.config.conventions !== undefined) return ["configured"];
  const branches = gitLines(
    root,
    "for-each-ref",
    "--count=10",
    "--sort=-committerdate",
    "--format=%(refname:short)",
    "refs/heads",
    "refs/remotes",
  );
  const commits = gitLines(root, "log", "-10", "--format=%s");
  return [
    "none configured",
    ...(branches.length === 0 ? [] : [`Branches: ${branches.join(", ")}`]),
    ...commits.map((subject) => `Commit: ${subject}`),
  ];
}

function gitLines(root: string, ...args: string[]): string[] {
  const output = gitOutputOrUndefined(root, ...args);
  if (output === undefined) return [];
  return output.split("\n").filter((line) => line !== "");
}

function inspectLegacy(ctx: CommandContext, root: string): string[] {
  const signals = detectLegacySignals(ctx, root);
  if (signals.length === 0) return ["none"];
  return [
    `${signals.length} signal${signals.length === 1 ? "" : "s"}`,
    ...signals.map(({ signal, topic }) => `${signal}: ${ctx.form} setup guide ${topic}`),
  ];
}

function detectLegacySignals(ctx: CommandContext, root: string): LegacySignal[] {
  const inRoot = (names: string[], topic: string) =>
    names
      .filter((name) => existsSync(join(root, name)))
      .map((name): LegacySignal => ({ signal: name, topic }));
  const inHome = (names: string[], topic: string) =>
    names
      .filter((name) => existsSync(join(ctx.home, name)))
      .map((name): LegacySignal => ({ signal: `~/${name}`, topic }));
  return [
    ...inRoot([".alignfirst.json", "workspace.mjs", "dev-server.mjs"], "upgrade-workspaces"),
    ...inRoot(["_docs/alignfirst", "_docs/vibe-flow", "_docs/ai-workflow"], "upgrade-v1"),
    ...(usesPlansShare(root)
      ? [{ signal: "plans-share in package.json", topic: "upgrade-v3" }]
      : []),
    ...resolveSkillRoots(ctx)
      .filter((skillRoot) => existsSync(join(skillRoot, "alignfirst", "references")))
      .map((skillRoot) => ({
        signal: `full-content alignfirst skill in ${skillRoot}`,
        topic: "upgrade-v3",
      })),
    ...inHome([".config/alignfirst", ".alignfirst/aligndev.config.json"], "upgrade"),
    ...(registryHasPaths(ctx.home)
      ? [{ signal: "companion registry with paths", topic: "upgrade" }]
      : []),
  ];
}

function usesPlansShare(root: string): boolean {
  const manifest = readPackageJson(root);
  if (manifest === undefined) return false;
  const sections = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
  const dependsOn = (name: string) => {
    const section = manifest[name];
    return isPlainObject(section) && Object.hasOwn(section, "plans-share");
  };
  if (sections.some(dependsOn)) return true;
  const scripts = manifest.scripts;
  return (
    isPlainObject(scripts) &&
    Object.values(scripts).some(
      (script) => typeof script === "string" && script.includes("plans-share"),
    )
  );
}

/** Read directly: the layout only warns about `paths`. */
function registryHasPaths(home: string): boolean {
  const path = registryPath(home);
  if (!existsSync(path)) return false;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    // The Companion item reports an unreadable registry.
    return false;
  }
  return isPlainObject(value) && Object.hasOwn(value, "paths");
}

function inspectSkillsState(ctx: CommandContext): string[] {
  const paseo = findInstalledSkill(resolveSkillRoots(ctx), PASEO_SKILL);
  const paseoText =
    paseo === undefined
      ? `${PASEO_SKILL} none`
      : `${PASEO_SKILL} ${paseo.version ?? "unknown"} (${paseo.root})`;
  return [
    "on disk; the session's skill list shows availability",
    ...inspectGlobalSkills(ctx).map(({ text }) => text),
    paseoText,
  ];
}

function inspectPaseo(root: string): string[] {
  const path = join(root, "paseo.json");
  if (!existsSync(path)) return ["no paseo.json"];
  const value: unknown = JSON.parse(readFileSync(path, "utf-8"));
  const worktree = isPlainObject(value) && isPlainObject(value.worktree) ? value.worktree : {};
  const hook = (name: string) =>
    `${name} hook ${hookCalls(worktree[name], `alignfirst workspace ${name}`) ? "calls" : "does not call"} alignfirst workspace ${name}`;
  return [`paseo.json present; ${hook("setup")}; ${hook("teardown")}`];
}

function hookCalls(hook: unknown, command: string): boolean {
  return JSON.stringify(hook ?? null).includes(command);
}
