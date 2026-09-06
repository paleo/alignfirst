import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { DEFAULT_ALIGNFIRST_COMMAND } from "./alignfirst-cli.js";
import { buildInventory, type ProjectInventory } from "./discovery.js";
import { renderProjectsGuide } from "./guide.js";
import {
  assertValidPortRange,
  MARKER_FILENAME,
  type PortRange,
  type ProjectsMarker,
  readMarker,
  writeMarker,
} from "./markers.js";
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

const USAGE = `Usage:
  alproject list [--json] [--root <path>]
  alproject doctor [--root <path>]
  alproject status <path> [--json] [--root <path>]
  alproject init [--root <path>] [--description <text>] [--port-range <first>-<last>]
  alproject free-ports --size <n> [--json] [--root <path>]
  alproject --guide [--root <path>]
  alproject --help
  alproject --version
`;

export interface MainOptions {
  argv?: string[];
  stdout?: Output;
  stderr?: Output;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  alignfirstCommand?: string[];
}

export interface Output {
  write(text: string): void;
}

export interface ProjectsContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  home: string;
  stdout: Output;
  stderr: Output;
  alignfirstCommand: string[];
}

interface ProjectsArgs {
  command?: "list" | "doctor" | "status" | "init" | "free-ports";
  path?: string;
  root?: string;
  json: boolean;
  guide: boolean;
  help: boolean;
  description?: string;
  portRange?: PortRange;
  size?: number;
}

export async function main(options?: MainOptions): Promise<number> {
  const argv = options?.argv ?? process.argv;
  const stdout = options?.stdout ?? process.stdout;
  const stderr = options?.stderr ?? process.stderr;
  const cwd = options?.cwd ?? process.cwd();
  const env = options?.env ?? process.env;
  const home = options?.home ?? env.HOME ?? env.USERPROFILE ?? homedir();
  const alignfirstCommand = options?.alignfirstCommand ?? DEFAULT_ALIGNFIRST_COMMAND;
  const tokens = argv.slice(2);

  if (tokens[0] === "--version" || tokens[0] === "-v") {
    stdout.write(`${readPackageVersion()}\n`);
    return 0;
  }

  try {
    return runProjects({ cwd, env, home, stdout, stderr, alignfirstCommand }, tokens);
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function readPackageVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version?: string;
  };
  if (pkg.version === undefined) throw new Error("alproject: package.json is missing 'version'");
  return pkg.version;
}

export function runProjects(ctx: ProjectsContext, tokens: string[]): number {
  const args = parseProjectsArgs(tokens);
  if (args.help || (args.command === undefined && !args.guide)) {
    ctx.stdout.write(USAGE);
    return 0;
  }
  if (args.command === "doctor") return inspectProjectInventory(ctx, args.root);
  const root = resolveProjectsRoot(ctx, args.root);
  if (args.guide) {
    const marker = readMarker(root);
    const inventory = marker === undefined ? undefined : inventoryFor(root, marker, ctx);
    ctx.stdout.write(`${renderProjectsGuide(inventory)}\n`);
    return 0;
  }
  if (args.command === "init") return initializeProjectsDirectory(root, args, ctx.stdout);
  const marker = requireMarker(root);
  const inventory = inventoryFor(root, marker, ctx);
  if (args.command === "list") {
    ctx.stdout.write(args.json ? renderProjectListJson(inventory) : renderProjectList(inventory));
    return 0;
  }
  if (args.command === "status" && args.path !== undefined) {
    const details = getProjectStatus(inventory, args.path);
    ctx.stdout.write(args.json ? renderProjectStatusJson(details) : renderProjectStatus(details));
    return 0;
  }
  if (args.command === "free-ports" && args.size !== undefined) {
    const range = findFreeBlock(inventory, args.size);
    ctx.stdout.write(args.json ? renderPortRangeJson(range) : `${range.first}..${range.last}\n`);
    return 0;
  }
  throw new Error("Invalid alproject command");
}

function inspectProjectInventory(ctx: ProjectsContext, rootOption: string | undefined): number {
  try {
    const root = resolveProjectsRoot(ctx, rootOption);
    const inventory = inventoryFor(root, requireMarker(root), ctx);
    ctx.stdout.write(renderProjectDoctor(inventory));
    return inventory.issues.length === 0 ? 0 : 1;
  } catch (error) {
    ctx.stdout.write(renderProjectDoctorFailure(errorMessage(error)));
    return 1;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseProjectsArgs(tokens: string[]): ProjectsArgs {
  const { values, positionals } = parseArgs({
    args: tokens,
    options: {
      root: { type: "string" },
      json: { type: "boolean", default: false },
      description: { type: "string" },
      "port-range": { type: "string" },
      size: { type: "string" },
      guide: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: true,
  });
  if (values.help) return emptyModeArgs(values.root, true, false);
  if (values.guide) {
    assertGuideArgs(positionals, values);
    return emptyModeArgs(values.root, false, true);
  }
  const [rawCommand, path, ...extra] = positionals;
  if (rawCommand === undefined) {
    assertNoCommandOptions(values);
    return emptyModeArgs(values.root, false, false);
  }
  if (!isProjectsCommand(rawCommand)) throw new Error(`Unknown projects command: ${rawCommand}`);
  validatePositionals(rawCommand, path, extra);
  validateOptionPlacement(rawCommand, values);
  return {
    command: rawCommand,
    ...(path === undefined ? {} : { path }),
    ...(values.root === undefined ? {} : { root: values.root }),
    json: values.json,
    guide: false,
    help: false,
    ...(values.description === undefined ? {} : { description: values.description }),
    ...(values["port-range"] === undefined
      ? {}
      : { portRange: parsePortRange(values["port-range"]) }),
    ...(values.size === undefined ? {} : { size: parsePositiveInteger("--size", values.size) }),
  };
}

interface ParsedOptionValues {
  root?: string;
  json: boolean;
  description?: string;
  "port-range"?: string;
  size?: string;
  guide: boolean;
  help: boolean;
}

function emptyModeArgs(root: string | undefined, help: boolean, guide: boolean): ProjectsArgs {
  return {
    ...(root === undefined ? {} : { root }),
    json: false,
    guide,
    help,
  };
}

function assertGuideArgs(positionals: string[], values: ParsedOptionValues): void {
  if (positionals.length > 0) throw new Error("--guide does not accept a command");
  if (
    values.json ||
    values.description !== undefined ||
    values["port-range"] !== undefined ||
    values.size !== undefined
  ) {
    throw new Error("--guide accepts only --root");
  }
}

function assertNoCommandOptions(values: ParsedOptionValues): void {
  if (
    values.json ||
    values.description !== undefined ||
    values["port-range"] !== undefined ||
    values.size !== undefined
  ) {
    throw new Error("Command options require a projects command");
  }
}

function isProjectsCommand(value: string): value is ProjectsArgs["command"] & string {
  return (
    value === "list" ||
    value === "doctor" ||
    value === "status" ||
    value === "init" ||
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
  if (values.json && command !== "list" && command !== "status" && command !== "free-ports") {
    throw new Error("--json is valid only with list, status, or free-ports");
  }
  if (
    command !== "init" &&
    (values.description !== undefined || values["port-range"] !== undefined)
  ) {
    throw new Error("--description and --port-range are valid only with init");
  }
  if (command === "free-ports") {
    if (values.size === undefined) throw new Error("free-ports requires --size <n>");
  } else if (values.size !== undefined) {
    throw new Error("--size is valid only with free-ports");
  }
}

function parsePortRange(value: string): PortRange {
  const match = /^(\d+)-(\d+)$/u.exec(value);
  if (match === null) throw new Error("--port-range must be <first>-<last>");
  const range = { first: Number(match[1]), last: Number(match[2]) };
  assertValidPortRange(range, "--port-range");
  return range;
}

function parsePositiveInteger(option: string, value: string): number {
  if (!/^[1-9]\d*$/u.test(value)) throw new Error(`${option} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${option} must be a positive integer`);
  return parsed;
}

function resolveProjectsRoot(ctx: ProjectsContext, rootOption: string | undefined): string {
  const input = rootOption ?? ctx.cwd;
  const expanded = input.startsWith("~/") ? join(ctx.home, input.slice(2)) : input;
  return realpathSync(isAbsolute(expanded) ? expanded : resolve(ctx.cwd, expanded));
}

function initializeProjectsDirectory(root: string, args: ProjectsArgs, stdout: Output): number {
  const markerPath = join(root, MARKER_FILENAME);
  if (readMarker(root) !== undefined) throw new Error(`${markerPath} already exists.`);
  writeMarker(root, {
    ...(args.description === undefined ? {} : { description: args.description }),
    ...(args.portRange === undefined ? {} : { portRange: args.portRange }),
  });
  stdout.write(`Created ${markerPath}\n`);
  return 0;
}

function requireMarker(root: string): ProjectsMarker {
  const marker = readMarker(root);
  if (marker !== undefined) return marker;
  throw new Error(
    `${root} is not a projects directory: ${MARKER_FILENAME} is missing. ` +
      "Run `alproject init` there, or pass --root <path>.",
  );
}

function inventoryFor(
  root: string,
  marker: ProjectsMarker,
  ctx: ProjectsContext,
): ProjectInventory {
  return buildInventory(root, marker, {
    env: ctx.env,
    home: ctx.home,
    alignfirstCommand: ctx.alignfirstCommand,
  });
}
