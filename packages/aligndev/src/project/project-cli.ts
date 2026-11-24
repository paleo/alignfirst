import { realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import type { CommandForms } from "../command-form.js";
import { type LoadedConfig, requirePortRange } from "../config.js";
import { errorMessage } from "../errors.js";
import type { Output } from "../output.js";
import { buildInventory, type ProjectInventory } from "./discovery.js";
import { formatRange } from "./format.js";
import { findFreeBlock } from "./ports.js";
import {
  renderPortRangeJson,
  renderProjectDoctor,
  renderProjectDoctorFailure,
  renderProjectList,
  renderProjectListJson,
  renderProjectStatus,
  renderProjectStatusJson,
} from "./render.js";
import { getProjectStatus } from "./status.js";

const DEFAULT_MAX_DEPTH = 5;

// What a caller supplies; the projects root default and the port range come from the config.
export interface ProjectsCallerContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  home: string;
  stdout: Output;
  stderr: Output;
  forms: CommandForms;
  alignfirstCommand: string[];
}

interface ProjectsContext extends ProjectsCallerContext {
  config: LoadedConfig;
}

interface ProjectsArgs {
  command?: "list" | "doctor" | "status" | "free-ports";
  path?: string;
  root?: string;
  maxDepth: number;
  json: boolean;
  help: boolean;
  size?: number;
}

export function runProject(
  tokens: string[],
  config: LoadedConfig,
  caller: ProjectsCallerContext,
): number {
  const ctx: ProjectsContext = { ...caller, config };
  try {
    return runProjectCommand(ctx, parseProjectsArgs(tokens));
  } catch (error) {
    ctx.stderr.write(`${errorMessage(error)}\n`);
    return 1;
  }
}

function runProjectCommand(ctx: ProjectsContext, args: ProjectsArgs): number {
  if (args.help || args.command === undefined) {
    ctx.stdout.write(renderUsage(ctx.forms.aligndev));
    return 0;
  }
  if (args.command === "doctor") return inspectProjectInventory(ctx, args);
  if (args.command === "free-ports") requirePortRange(ctx.config);
  const inventory = scanProjects(ctx, args);
  if (args.command === "list") {
    ctx.stdout.write(args.json ? renderProjectListJson(inventory) : renderProjectList(inventory));
    return 0;
  }
  if (args.command === "status" && args.path !== undefined) {
    const details = getProjectStatus(inventory, resolve(ctx.cwd, args.path));
    ctx.stdout.write(args.json ? renderProjectStatusJson(details) : renderProjectStatus(details));
    return 0;
  }
  if (args.command === "free-ports" && args.size !== undefined) {
    const range = findFreeBlock(inventory, args.size);
    ctx.stdout.write(args.json ? renderPortRangeJson(range) : `${formatRange(range)}\n`);
    return 0;
  }
  throw new Error("Invalid aligndev project command");
}

function renderUsage(aligndev: string): string {
  return `Usage:
  ${aligndev} project list [--json] [--root <path>] [--max-depth <n>]
  ${aligndev} project doctor [--root <path>] [--max-depth <n>]
  ${aligndev} project status <path> [--json] [--root <path>] [--max-depth <n>]
  ${aligndev} project free-ports --size <n> [--json] [--root <path>] [--max-depth <n>]
  ${aligndev} project --help

--root defaults to projectsRoot in the aligndev settings, then to the working directory.
--max-depth limits the scan through groups; the root's children are at depth 1. Default: ${DEFAULT_MAX_DEPTH}.
free-ports looks up a free block inside portRange in the aligndev settings.
A relative status <path> starts from the working directory.
`;
}

function inspectProjectInventory(ctx: ProjectsContext, args: ProjectsArgs): number {
  try {
    const inventory = scanProjects(ctx, args);
    ctx.stdout.write(renderProjectDoctor(inventory));
    return inventory.issues.length === 0 ? 0 : 1;
  } catch (error) {
    ctx.stdout.write(renderProjectDoctorFailure(errorMessage(error)));
    return 1;
  }
}

function scanProjects(ctx: ProjectsContext, args: ProjectsArgs): ProjectInventory {
  const root = resolveProjectsRoot(ctx, args.root);
  return buildInventory(
    root,
    { portRange: ctx.config.portRange, maxDepth: args.maxDepth },
    { env: ctx.env, alignfirstCommand: ctx.alignfirstCommand },
  );
}

function resolveProjectsRoot(ctx: ProjectsContext, rootOption: string | undefined): string {
  if (rootOption !== undefined) return realpathSync(resolveRootOption(ctx, rootOption));
  return realpathSync(ctx.config.projectsRoot?.path ?? ctx.cwd);
}

function resolveRootOption(ctx: ProjectsContext, rootOption: string): string {
  const expanded = rootOption.startsWith("~/") ? join(ctx.home, rootOption.slice(2)) : rootOption;
  return isAbsolute(expanded) ? expanded : resolve(ctx.cwd, expanded);
}

function parseProjectsArgs(tokens: string[]): ProjectsArgs {
  const { values, positionals } = parseArgs({
    args: tokens,
    options: {
      root: { type: "string" },
      "max-depth": { type: "string" },
      json: { type: "boolean", default: false },
      size: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: true,
  });
  if (values.help) return emptyModeArgs(values.root, true);
  const [rawCommand, path, ...extra] = positionals;
  if (rawCommand === undefined) {
    assertNoCommandOptions(values);
    return emptyModeArgs(values.root, false);
  }
  if (!isProjectsCommand(rawCommand)) throw new Error(`Unknown projects command: ${rawCommand}`);
  validatePositionals(rawCommand, path, extra);
  validateOptionPlacement(rawCommand, values);
  return {
    command: rawCommand,
    ...(path === undefined ? {} : { path }),
    ...(values.root === undefined ? {} : { root: values.root }),
    maxDepth:
      values["max-depth"] === undefined
        ? DEFAULT_MAX_DEPTH
        : parsePositiveInteger("--max-depth", values["max-depth"]),
    json: values.json,
    help: false,
    ...(values.size === undefined ? {} : { size: parsePositiveInteger("--size", values.size) }),
  };
}

interface ParsedOptionValues {
  root?: string;
  "max-depth"?: string;
  json: boolean;
  size?: string;
  help: boolean;
}

function emptyModeArgs(root: string | undefined, help: boolean): ProjectsArgs {
  return {
    ...(root === undefined ? {} : { root }),
    maxDepth: DEFAULT_MAX_DEPTH,
    json: false,
    help,
  };
}

function assertNoCommandOptions(values: ParsedOptionValues): void {
  if (values.json || values["max-depth"] !== undefined || values.size !== undefined) {
    throw new Error("Command options require a projects command");
  }
}

function isProjectsCommand(value: string): value is ProjectsArgs["command"] & string {
  return value === "list" || value === "doctor" || value === "status" || value === "free-ports";
}

function validatePositionals(command: string, path: string | undefined, extra: string[]): void {
  if (command === "status") {
    if (path === undefined || extra.length > 0) throw new Error("status requires exactly one path");
    return;
  }
  if (path !== undefined) throw new Error(`${command} does not accept a path`);
}

function validateOptionPlacement(command: string, values: ParsedOptionValues): void {
  if (values.json && command === "doctor") {
    throw new Error("--json is valid only with list, status, or free-ports");
  }
  if (command === "free-ports") {
    if (values.size === undefined) throw new Error("free-ports requires --size <n>");
  } else if (values.size !== undefined) {
    throw new Error("--size is valid only with free-ports");
  }
}

function parsePositiveInteger(option: string, value: string): number {
  if (!/^[1-9]\d*$/u.test(value)) throw new Error(`${option} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${option} must be a positive integer`);
  return parsed;
}
