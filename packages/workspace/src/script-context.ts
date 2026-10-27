import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type { Command } from "./config.js";
import { ConfigError } from "./errors.js";
import type { SetupContextBase } from "./file-entries.js";
import { composeProjectName } from "./helpers.js";
import { getWorktreeBranch } from "./worktree.js";

const scalarFields = new Set([
  "phase",
  "name",
  "currentWorktree",
  "mainWorktree",
  "configurationDir",
  "companionDir",
  "runtimeDir",
  "isMainWorktree",
  "composeProject",
  "branch",
  "force",
  "verbose",
  "file",
  "status",
]);
const conveniences = [
  ["name", "NAME"],
  ["currentWorktree", "CURRENT_WORKTREE"],
  ["mainWorktree", "MAIN_WORKTREE"],
  ["isMainWorktree", "IS_MAIN_WORKTREE"],
  ["composeProject", "COMPOSE_PROJECT"],
  ["branch", "BRANCH"],
  ["force", "FORCE"],
  ["verbose", "VERBOSE"],
] as const;

const abiVariables = new Set([
  "ALIGNFIRST_CONTEXT",
  "ALIGNFIRST_WORKSPACE_CONTEXT",
  ...conveniences.map(([, suffix]) => `ALIGNFIRST_${suffix}`),
]);

export interface ScriptStorageContext {
  configurationDir?: string;
  companionDir?: string;
  runtimeDir: string;
}

export interface ScriptContext extends Omit<SetupContextBase, "signal">, ScriptStorageContext {
  phase: ScriptPhase;
  composeProject: string;
  branch?: string;
  force?: boolean;
  verbose?: boolean;
  ports?: Record<string, number>;
  file?: string;
  status?: "pending" | "ready" | "failed";
  servers?: ScriptServerResult[];
}

export interface ScriptServerResult {
  name: string;
  kind: "spawn" | "command";
  port?: number;
  pid?: number;
  logFile?: string;
}

export type ScriptPhase =
  | "preSetup"
  | "finalize"
  | "purge"
  | "devSetup"
  | "workspaceFileContent"
  | "workspaceFilePatch"
  | "runFileContent"
  | "runFilePatch"
  | "runFilesInputs"
  | "start"
  | "stop"
  | "workspaceSummary"
  | "devSummary";

export interface ScriptContextFields {
  force?: boolean;
  verbose?: boolean;
  ports?: Record<string, number>;
  file?: string;
  status?: "pending" | "ready" | "failed";
  servers?: ScriptServerResult[];
}

export interface ResolvedCommand {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export function scriptContext(
  base: SetupContextBase & ScriptStorageContext,
  phase: ScriptPhase,
  fields: ScriptContextFields = {},
): ScriptContext {
  const ctx: ScriptContext = {
    phase,
    name: base.name,
    currentWorktree: resolve(base.currentWorktree),
    mainWorktree: resolve(base.mainWorktree),
    isMainWorktree: base.isMainWorktree,
    composeProject: composeProjectName(base.name),
    runtimeDir: resolve(base.runtimeDir),
    ...(base.configurationDir === undefined
      ? {}
      : { configurationDir: resolve(base.configurationDir) }),
    ...(base.companionDir === undefined ? {} : { companionDir: resolve(base.companionDir) }),
  };
  if (existsSync(ctx.currentWorktree)) {
    ctx.branch = getWorktreeBranch(ctx.currentWorktree) ?? "(detached)";
  }
  if (["preSetup", "finalize", "devSetup"].includes(phase)) ctx.force = fields.force ?? false;
  if (["preSetup", "finalize", "devSetup", "purge"].includes(phase)) {
    ctx.verbose = fields.verbose ?? false;
  }
  if (
    [
      "devSetup",
      "runFileContent",
      "runFilePatch",
      "runFilesInputs",
      "start",
      "stop",
      "devSummary",
    ].includes(phase)
  ) {
    ctx.ports = Object.fromEntries(Object.entries(fields.ports ?? {}));
  }
  if (phase.endsWith("FileContent") || phase.endsWith("FilePatch")) ctx.file = fields.file;
  if (phase === "workspaceSummary") ctx.status = fields.status;
  if (phase === "devSummary") ctx.servers = fields.servers;
  return ctx;
}

export function interpolate(text: string, ctx: ScriptContext, field: string): string {
  return text.replace(/\$\{\{(.*?)\}\}/gs, (_match, raw: string) => {
    const ref = raw.trim();
    let value: unknown;
    if (ref.startsWith("ports.")) {
      const key = ref.slice(6);
      if (ctx.ports && Object.hasOwn(ctx.ports, key)) value = ctx.ports[key];
    } else if (scalarFields.has(ref) && Object.hasOwn(ctx, ref)) {
      value = Reflect.get(ctx, ref);
    }
    if (!["string", "number", "boolean"].includes(typeof value)) {
      throw new ConfigError(`${field}: unavailable reference ${ref} in phase ${ctx.phase}.`);
    }
    return String(value);
  });
}

export function resolveCommand(
  command: Command,
  ctx: ScriptContext,
  field: string,
  executionBase = ctx.currentWorktree,
  inherited: NodeJS.ProcessEnv = process.env,
): ResolvedCommand {
  const run =
    typeof command.run === "string"
      ? ["/bin/sh", "-c", command.run]
      : command.run.map((arg, index) => interpolate(arg, ctx, `${field}.run[${index}]`));
  if (run.length === 0 || run[0] === "") throw new ConfigError(`${field}: empty executable.`);
  const cwd = resolve(executionBase, interpolate(command.cwd ?? ".", ctx, `${field}.cwd`));
  const env = Object.fromEntries(
    Object.entries(inherited).filter(([key]) => !abiVariables.has(key)),
  );
  Object.setPrototypeOf(env, null);
  for (const [key, value] of Object.entries(command.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || abiVariables.has(key)) {
      throw new ConfigError(`${field}.env: invalid or reserved environment name ${key}.`);
    }
    env[key] = interpolate(value, ctx, `${field}.env.${key}`);
  }
  env.ALIGNFIRST_WORKSPACE_CONTEXT = JSON.stringify(ctx);
  for (const [key, suffix] of conveniences) {
    const value = ctx[key];
    if (value !== undefined) env[`ALIGNFIRST_${suffix}`] = String(value);
  }
  if (
    [...run, cwd, ...Object.values(env).filter((v) => v !== undefined)].some((v) =>
      v.includes("\0"),
    )
  ) {
    throw new ConfigError(`${field}: command contains NUL.`);
  }
  return { command: run[0], args: run.slice(1), cwd, env };
}
