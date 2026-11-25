import { realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import type { CommandForms } from "../command-form.js";
import type { LoadedConfig } from "../config.js";
import { errorMessage } from "../errors.js";
import type { Output } from "../output.js";
import { buildInventory, type ProjectInventory } from "./discovery.js";
import { formatRange } from "./format.js";
import { findFreeBlock, type PortRange } from "./ports.js";
import {
  renderFreePortsJson,
  renderProjectDoctor,
  renderProjectDoctorFailure,
  renderProjectList,
  renderProjectListJson,
  renderProjectPorts,
  renderProjectPortsJson,
  renderProjectStatus,
  renderProjectStatusJson,
  renderUnknownRangeWarnings,
} from "./render.js";
import { getProjectStatus } from "./status.js";

const DEFAULT_MAX_DEPTH = 5;

// What a caller supplies; the projects root default comes from the config.
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
  command?: "list" | "doctor" | "status" | "ports" | "free-ports";
  path?: string;
  root?: string;
  maxDepth: number;
  json: boolean;
  help: boolean;
  size?: number;
  within?: PortRange;
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
  if (args.command === "free-ports" && args.size !== undefined && args.within !== undefined) {
    return showFreePorts(ctx, args, args.size, args.within);
  }
  if (args.command === "ports") return showPorts(ctx, args);
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
  throw new Error("Invalid aligndev project command");
}

function showFreePorts(
  ctx: ProjectsContext,
  args: ProjectsArgs,
  size: number,
  within: PortRange,
): number {
  const inventory = scanPortClaims(ctx, args);
  const range = findFreeBlock(inventory, within, size);
  ctx.stdout.write(args.json ? renderFreePortsJson(inventory, range) : `${formatRange(range)}\n`);
  return 0;
}

// The text mode warns about the unknown ranges; the JSON mode carries them.
function scanPortClaims(ctx: ProjectsContext, args: ProjectsArgs): ProjectInventory {
  const inventory = scanProjects(ctx, args);
  if (!args.json) ctx.stderr.write(renderUnknownRangeWarnings(inventory, ctx.forms.aligndev));
  return inventory;
}

function showPorts(ctx: ProjectsContext, args: ProjectsArgs): number {
  const inventory = scanPortClaims(ctx, args);
  ctx.stdout.write(args.json ? renderProjectPortsJson(inventory) : renderProjectPorts(inventory));
  return 0;
}

function renderUsage(aligndev: string): string {
  return `Usage:
  ${aligndev} project list [--json] [--root <path>] [--max-depth <n>]
  ${aligndev} project doctor [--root <path>] [--max-depth <n>]
  ${aligndev} project status <path> [--json] [--root <path>] [--max-depth <n>]
  ${aligndev} project ports [--json] [--root <path>] [--max-depth <n>]
  ${aligndev} project free-ports --size <n> --within <first>..<last> [--json] [--root <path>] [--max-depth <n>]
  ${aligndev} project --help

--root defaults to projectsRoot in the aligndev settings, then to the working directory.
--max-depth limits the scan through groups; the root's children are at depth 1. Default: ${DEFAULT_MAX_DEPTH}.
ports prints the claimed port ranges, sorted by first port.
free-ports prints the lowest block of <n> ports inside --within that overlaps no project range.
--size is the number of port names × the expected concurrent workspaces.
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
    { maxDepth: args.maxDepth },
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
      within: { type: "string" },
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
    ...(values.within === undefined ? {} : { within: parsePortBounds(values.within) }),
  };
}

interface ParsedOptionValues {
  root?: string;
  "max-depth"?: string;
  json: boolean;
  size?: string;
  within?: string;
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
  if (
    values.json ||
    values["max-depth"] !== undefined ||
    values.size !== undefined ||
    values.within !== undefined
  ) {
    throw new Error("Command options require a projects command");
  }
}

function isProjectsCommand(value: string): value is ProjectsArgs["command"] & string {
  return (
    value === "list" ||
    value === "doctor" ||
    value === "status" ||
    value === "ports" ||
    value === "free-ports"
  );
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
    throw new Error("--json is valid only with list, status, ports, or free-ports");
  }
  if (command === "free-ports") {
    if (values.size === undefined) throw new Error("free-ports requires --size <n>");
    if (values.within === undefined)
      throw new Error("free-ports requires --within <first>..<last>");
  } else if (values.size !== undefined) {
    throw new Error("--size is valid only with free-ports");
  } else if (values.within !== undefined) {
    throw new Error("--within is valid only with free-ports");
  }
}

function parsePositiveInteger(option: string, value: string): number {
  if (!/^[1-9]\d*$/u.test(value)) throw new Error(`${option} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${option} must be a positive integer`);
  return parsed;
}

function parsePortBounds(value: string): PortRange {
  const match = /^(\d+)\.\.(\d+)$/u.exec(value);
  if (match === null) throw new Error("--within must be <first>..<last>");
  const first = Number(match[1]);
  const last = Number(match[2]);
  if (!isPort(first) || !isPort(last))
    throw new Error("--within ports must be integers from 1 to 65535");
  if (first > last) throw new Error("--within first port must not exceed the last port");
  return { first, last };
}

function isPort(value: number): boolean {
  return value >= 1 && value <= 65_535;
}
