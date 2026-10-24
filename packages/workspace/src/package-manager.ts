import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createCommand,
  type LaunchEvidence,
  type PackageManager,
  readLaunchEvidence,
  resolveInvocation,
  scriptCommand,
} from "@alignfirst/docmap/invocation";

let active: PackageManagerCommands | undefined;

export interface PackageManagerCommands {
  workspace: ScriptInvocation;
  dev: ScriptInvocation;
  install: string;
  runtime: string;
}

export interface ScriptInvocation {
  base: string;
  withArgs: string;
}

export interface WrapperPaths {
  workspace?: string;
  dev?: string;
}

export function wsCmd(args: string): string {
  return `${packageManagerCommands().workspace.withArgs} ${args}`;
}

export function devCmd(args: string): string {
  return `${packageManagerCommands().dev.withArgs} ${args}`;
}

/** Each wrapper entry resets the context; uninitialized library calls never cache ambient evidence. */
export function configureCommands(wrappers: WrapperPaths): void {
  active = detectPackageManager(process.cwd(), readLaunchEvidence(), wrappers);
}

export function packageManagerCommands(): PackageManagerCommands {
  return active ?? detectPackageManager(process.cwd());
}

export function detectPackageManager(
  cwd: string,
  evidence: LaunchEvidence = { ...readLaunchEvidence(), cwd },
  wrappers: WrapperPaths = {},
): PackageManagerCommands {
  const invocation = resolveInvocation(
    { packageName: "@alignfirst/workspace", binaryName: "workspace" },
    evidence,
  );
  const manager = evidence.runtime === "bun" ? "bun" : (invocation.manager ?? lockfileManager(cwd));
  return {
    workspace: wrapperCommand("workspace", wrappers.workspace, manager, evidence),
    dev: wrapperCommand("dev", wrappers.dev, manager, evidence),
    install: manager === "pnpm" ? "pnpm i" : `${manager} install`,
    runtime: createCommand(evidence.executable).base,
  };
}

function wrapperCommand(
  name: string,
  wrapper: string | undefined,
  manager: PackageManager,
  evidence: LaunchEvidence,
): ScriptInvocation {
  const invocation = resolveInvocation(
    { packageName: "@alignfirst/workspace", binaryName: name },
    evidence,
  );
  const ownsWrapper =
    wrapper === undefined
      ? evidence.env.npm_lifecycle_event === name
      : sameFile(wrapper, evidence.entryPoint);
  const verified = ownsWrapper ? invocation.script : undefined;
  if (verified !== undefined && (evidence.runtime !== "bun" || manager === "bun")) {
    return scriptCommand(manager, verified.name, {
      runtime: evidence.runtime,
      directory: verified.directory,
      cwd: evidence.cwd,
    });
  }
  // Workspace is binless: a known wrapper is safer than inventing a package-runner command.
  if (evidence.runtime === "bun" && wrapper !== undefined) {
    return createCommand(evidence.executable, [wrapper]);
  }
  if (manager === "pnpm") return createCommand("pnpm", [name]);
  return scriptCommand(manager, name, { runtime: evidence.runtime });
}

function sameFile(wrapper: string, entry: string | undefined): boolean {
  if (entry === undefined) return false;
  try {
    return realpathSync(wrapper) === realpathSync(entry);
  } catch {
    return false;
  }
}

function lockfileManager(cwd: string): PackageManager {
  let dir = cwd;
  while (true) {
    if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
    if (existsSync(join(dir, "yarn.lock"))) return "yarn";
    if (existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock"))) return "bun";
    if (existsSync(join(dir, "package-lock.json"))) return "npm";
    const parent = dirname(dir);
    if (parent === dir) return "npm";
    dir = parent;
  }
}
