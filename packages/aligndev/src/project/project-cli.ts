import { realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import type { CommandForms } from "../command-form.js";
import type { AligndevConfig, ProjectsRoot } from "../config.js";
import { errorMessage } from "../errors.js";
import type { Output } from "../output.js";
import { buildInventory, type ProjectInventory } from "./discovery.js";
import { formatRange } from "./format.js";
import { renderProjectsGuide } from "./guide.js";
import {
  assertValidPortRanges,
  MARKER_FILENAME,
  type MarkerPortRange,
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

export interface ProjectsContext extends ProjectsCallerContext {
  projectsRoot?: ProjectsRoot;
}

interface ProjectsArgs {
  command?: "list" | "doctor" | "status" | "init" | "free-ports";
  path?: string;
  root?: string;
  json: boolean;
  help: boolean;
  description?: string;
  portRanges?: MarkerPortRange[];
  range?: string;
  size?: number;
}

export function runProject(
  tokens: string[],
  config: AligndevConfig | undefined,
  caller: ProjectsCallerContext,
): number {
  const ctx: ProjectsContext = { ...caller, projectsRoot: config?.projectsRoot };
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
  if (args.command === "doctor") return inspectProjectInventory(ctx, args.root);
  const root = resolveProjectsRoot(ctx, args.root);
  if (args.command === "init") return initializeProjectsDirectory(root, args, ctx.stdout);
  const marker = requireMarker(root, ctx.forms.aligndev);
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
    const range = findFreeBlock(inventory, args.size, args.range);
    ctx.stdout.write(args.json ? renderPortRangeJson(range) : `${formatRange(range)}\n`);
    return 0;
  }
  throw new Error("Invalid aligndev project command");
}

function renderUsage(aligndev: string): string {
  return `Usage:
  ${aligndev} project list [--json] [--root <path>]
  ${aligndev} project doctor [--root <path>]
  ${aligndev} project status <path> [--json] [--root <path>]
  ${aligndev} project init [--root <path>] [--description <text>] [--port-range [<code>=]<first>-<last>]...
  ${aligndev} project free-ports --size <n> [--range <code>] [--json] [--root <path>]
  ${aligndev} project --help

--root defaults to projectsRoot in the aligndev config, then to the working directory.
`;
}

// The projects guide, followed by the directory sections when the root carries a marker.
export function renderProjectsGuideForRoot(
  ctx: ProjectsContext,
  rootOption: string | undefined,
): string {
  const root = resolveProjectsRoot(ctx, rootOption);
  const marker = readMarker(root);
  const inventory = marker === undefined ? undefined : inventoryFor(root, marker, ctx);
  return renderProjectsGuide(ctx.forms, inventory);
}

function inspectProjectInventory(ctx: ProjectsContext, rootOption: string | undefined): number {
  try {
    const root = resolveProjectsRoot(ctx, rootOption);
    const inventory = inventoryFor(root, requireMarker(root, ctx.forms.aligndev), ctx);
    ctx.stdout.write(renderProjectDoctor(inventory));
    return inventory.issues.length === 0 ? 0 : 1;
  } catch (error) {
    ctx.stdout.write(renderProjectDoctorFailure(errorMessage(error)));
    return 1;
  }
}

function parseProjectsArgs(tokens: string[]): ProjectsArgs {
  const { values, positionals } = parseArgs({
    args: tokens,
    options: {
      root: { type: "string" },
      json: { type: "boolean", default: false },
      description: { type: "string" },
      "port-range": { type: "string", multiple: true },
      range: { type: "string" },
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
    json: values.json,
    help: false,
    ...(values.description === undefined ? {} : { description: values.description }),
    ...(values["port-range"] === undefined
      ? {}
      : { portRanges: parsePortRanges(values["port-range"]) }),
    ...(values.range === undefined ? {} : { range: values.range }),
    ...(values.size === undefined ? {} : { size: parsePositiveInteger("--size", values.size) }),
  };
}

interface ParsedOptionValues {
  root?: string;
  json: boolean;
  description?: string;
  "port-range"?: string[];
  range?: string;
  size?: string;
  help: boolean;
}

function emptyModeArgs(root: string | undefined, help: boolean): ProjectsArgs {
  return {
    ...(root === undefined ? {} : { root }),
    json: false,
    help,
  };
}

function assertNoCommandOptions(values: ParsedOptionValues): void {
  if (
    values.json ||
    values.description !== undefined ||
    values["port-range"] !== undefined ||
    values.range !== undefined ||
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
  if (values.range !== undefined && command !== "free-ports") {
    throw new Error("--range is valid only with free-ports");
  }
  if (command === "free-ports") {
    if (values.size === undefined) throw new Error("free-ports requires --size <n>");
  } else if (values.size !== undefined) {
    throw new Error("--size is valid only with free-ports");
  }
}

function parsePortRanges(values: string[]): MarkerPortRange[] {
  const ranges = values.map(parsePortRange);
  assertValidPortRanges(ranges, "--port-range");
  return ranges;
}

function parsePortRange(value: string): MarkerPortRange {
  const match = /^(?:([a-z][a-z0-9-]*)=)?(\d+)-(\d+)$/u.exec(value);
  if (match === null) throw new Error("--port-range must be [<code>=]<first>-<last>");
  return {
    ...(match[1] === undefined ? {} : { code: match[1] }),
    first: Number(match[2]),
    last: Number(match[3]),
  };
}

function parsePositiveInteger(option: string, value: string): number {
  if (!/^[1-9]\d*$/u.test(value)) throw new Error(`${option} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${option} must be a positive integer`);
  return parsed;
}

function resolveProjectsRoot(ctx: ProjectsContext, rootOption: string | undefined): string {
  if (rootOption !== undefined) return realpathSync(resolveRootOption(ctx, rootOption));
  return realpathSync(ctx.projectsRoot?.path ?? ctx.cwd);
}

function resolveRootOption(ctx: ProjectsContext, rootOption: string): string {
  const expanded = rootOption.startsWith("~/") ? join(ctx.home, rootOption.slice(2)) : rootOption;
  return isAbsolute(expanded) ? expanded : resolve(ctx.cwd, expanded);
}

function initializeProjectsDirectory(root: string, args: ProjectsArgs, stdout: Output): number {
  const markerPath = join(root, MARKER_FILENAME);
  if (readMarker(root) !== undefined) throw new Error(`${markerPath} already exists.`);
  writeMarker(root, {
    ...(args.description === undefined ? {} : { description: args.description }),
    ...(args.portRanges === undefined ? {} : { portRanges: args.portRanges }),
  });
  stdout.write(`Created ${markerPath}\n`);
  return 0;
}

function requireMarker(root: string, aligndev: string): ProjectsMarker {
  const marker = readMarker(root);
  if (marker !== undefined) return marker;
  throw new Error(
    `${root} is not a projects directory: ${MARKER_FILENAME} is missing. ` +
      `Run \`${aligndev} project init\` there, or pass --root <path>.`,
  );
}

function inventoryFor(
  root: string,
  marker: ProjectsMarker,
  ctx: ProjectsContext,
): ProjectInventory {
  return buildInventory(root, marker, {
    env: ctx.env,
    alignfirstCommand: ctx.alignfirstCommand,
  });
}
