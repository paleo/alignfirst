import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { parseArgs } from "node:util";

import { readConfig, readConfigIfPresent } from "./config.js";
import { buildProjectList, type ProjectList, type ProjectStatus } from "./discovery.js";
import { errorMessage } from "./errors.js";
import { renderGuide } from "./guide.js";
import { registerProject, unregisterProject } from "./mutations.js";
import { readRegistry } from "./registry.js";
import { getProjectStatus, type ProjectDetails } from "./status.js";

const statusLabels: Record<ProjectStatus, string> = {
  missing: "registered but missing from filesystem",
  registered: "registered",
  unregistered: "unregistered on filesystem",
};

export interface MainOptions {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  home?: string;
  stderr?: Output;
  stdout?: Output;
}

export interface Output {
  write(text: string): void;
}

export interface AlprojectArgs {
  allowOutsidePortRange: boolean;
  basePort?: number;
  command?: string;
  guide: boolean;
  help: boolean;
  json: boolean;
  maxWorkspaces?: number;
  path?: string;
  portsPerWorkspace?: number;
  version: boolean;
}

interface PortOptionValues {
  "allow-outside-port-range"?: boolean;
  "base-port"?: string;
  "max-workspaces"?: string;
  "ports-per-workspace"?: string;
}

export async function main(options: MainOptions = {}): Promise<number> {
  const argv = options.argv ?? process.argv;
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? env.USERPROFILE ?? homedir();
  const stderr = options.stderr ?? process.stderr;
  const stdout = options.stdout ?? process.stdout;

  let args: AlprojectArgs;
  try {
    args = parseAlprojectArgs(argv);
  } catch (error) {
    stderr.write(`${escapeControlCharacters(errorMessage(error))}\n`);
    return 1;
  }

  if (args.version) {
    stdout.write(`${readPackageVersion()}\n`);
    return 0;
  }
  if (args.help) {
    stdout.write(renderHelp());
    return 0;
  }

  try {
    if (args.guide) {
      const config = readConfigIfPresent(home);
      stdout.write(ensureTrailingNewline(renderGuide(config?.root.path)));
      return 0;
    }
    if (args.command === undefined) {
      stdout.write(renderHelp());
      return 0;
    }
    const config = readConfig(home);
    if (args.command === "list") {
      const list = buildProjectList(config, readRegistry(config));
      stdout.write(args.json ? renderProjectListJson(list) : renderProjectList(list));
      return 0;
    }
    if (args.command === "status" && args.path !== undefined) {
      const status = getProjectStatus(config, readRegistry(config), args.path);
      stdout.write(args.json ? renderProjectStatusJson(status) : renderProjectStatus(status));
      return 0;
    }
    if (args.command === "register" && args.path !== undefined) {
      const result = await registerProject(config, args.path, {
        allowOutsidePortRange: args.allowOutsidePortRange,
        basePort: args.basePort,
        maxWorkspaces: args.maxWorkspaces,
        portsPerWorkspace: args.portsPerWorkspace,
      });
      stdout.write(renderRegistration(result));
      return 0;
    }
    if (args.command === "unregister" && args.path !== undefined) {
      const path = await unregisterProject(config, args.path);
      stdout.write(`Unregistered project: ${renderOutputValue(path)}\n`);
      return 0;
    }
    throw new Error(`Unknown command: ${args.command}`);
  } catch (error) {
    stderr.write(`${escapeControlCharacters(errorMessage(error))}\n`);
    return 1;
  }
}

export function parseAlprojectArgs(argv: string[]): AlprojectArgs {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    args: argv.slice(2),
    options: {
      "allow-outside-port-range": { default: false, type: "boolean" },
      "base-port": { type: "string" },
      guide: { default: false, type: "boolean" },
      help: { default: false, short: "h", type: "boolean" },
      json: { default: false, type: "boolean" },
      "max-workspaces": { type: "string" },
      "ports-per-workspace": { type: "string" },
      version: { default: false, short: "v", type: "boolean" },
    },
    strict: true,
  });
  const selectedModes = [
    values.guide === true ? "--guide" : undefined,
    values.help === true ? "--help" : undefined,
    values.version === true ? "--version" : undefined,
  ].filter((mode) => mode !== undefined);
  if (selectedModes.length > 1) {
    throw new Error("--guide, --help, and --version are mutually exclusive");
  }
  if (selectedModes.length === 1) {
    if (positionals.length > 0) throw new Error(`${selectedModes[0]} does not accept a command`);
    if (values.json === true || hasPortOptions(values)) {
      throw new Error(`${selectedModes[0]} does not accept command options`);
    }
    return {
      allowOutsidePortRange: false,
      guide: values.guide === true,
      help: values.help === true,
      json: false,
      version: values.version === true,
    };
  }

  const [command, path, ...extraPaths] = positionals;
  if (command === undefined) {
    if (values.json === true) throw new Error("--json is valid only with list or status");
    if (hasPortOptions(values)) {
      throw new Error("Port options are valid only with register");
    }
    return {
      allowOutsidePortRange: false,
      guide: false,
      help: false,
      json: false,
      version: false,
    };
  }
  if (!isCommand(command)) throw new Error(`Unknown command: ${command}`);
  validateCommandPaths(command, path, extraPaths);
  validatePortOptionPlacement(command, values);
  if (values.json === true && command !== "list" && command !== "status") {
    throw new Error("--json is valid only with list or status");
  }
  const portsPerWorkspace = parsePositiveInteger(
    "--ports-per-workspace",
    values["ports-per-workspace"],
  );
  const maxWorkspaces = parsePositiveInteger("--max-workspaces", values["max-workspaces"]);
  const basePort = parsePositiveInteger("--base-port", values["base-port"]);
  const allowOutsidePortRange = values["allow-outside-port-range"] === true;
  if ((portsPerWorkspace === undefined) !== (maxWorkspaces === undefined)) {
    throw new Error("--ports-per-workspace and --max-workspaces must be provided together");
  }
  if (basePort !== undefined && portsPerWorkspace === undefined) {
    throw new Error("--base-port requires --ports-per-workspace and --max-workspaces");
  }
  if (allowOutsidePortRange && basePort === undefined) {
    throw new Error("--allow-outside-port-range requires --base-port");
  }
  return {
    allowOutsidePortRange,
    basePort,
    command,
    guide: false,
    help: false,
    json: values.json === true,
    maxWorkspaces,
    path,
    portsPerWorkspace,
    version: false,
  };
}

function hasPortOptions(values: PortOptionValues): boolean {
  return (
    values["allow-outside-port-range"] === true ||
    values["base-port"] !== undefined ||
    values["ports-per-workspace"] !== undefined ||
    values["max-workspaces"] !== undefined
  );
}

function isCommand(value: string): value is "list" | "register" | "status" | "unregister" {
  return value === "list" || value === "register" || value === "status" || value === "unregister";
}

function validateCommandPaths(
  command: string,
  path: string | undefined,
  extraPaths: string[],
): void {
  if (command === "list") {
    if (path !== undefined) throw new Error("list does not accept a path");
    return;
  }
  if (path === undefined) throw new Error(`${command} requires exactly one path`);
  if (extraPaths.length > 0) throw new Error(`${command} requires exactly one path`);
}

function validatePortOptionPlacement(command: string, values: PortOptionValues): void {
  if (command !== "register" && hasPortOptions(values)) {
    throw new Error("Port options are valid only with register");
  }
}

function parsePositiveInteger(option: string, value: string | undefined): number | undefined {
  if (value === undefined) return;
  if (!/^[1-9]\d*$/u.test(value)) throw new Error(`${option} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${option} must be a positive integer`);
  return parsed;
}

function readPackageVersion(): string {
  const packageFile = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as {
    version?: string;
  };
  if (packageFile.version === undefined) {
    throw new Error("alproject: package.json is missing 'version'");
  }
  return packageFile.version;
}

function renderHelp(): string {
  return `alproject — discover and manage local Git projects.

Usage:
  alproject list [--json]
  alproject status <path> [--json]
  alproject register <path> [--ports-per-workspace <n> --max-workspaces <n> [--base-port <n> [--allow-outside-port-range]]]
  alproject unregister <path>

Options:
  --guide              Print the complete guide
  -h, --help           Print this help
  --json               Print structured list or status output
  --allow-outside-port-range
                       Permit an explicit allocation outside configured ranges
  -v, --version        Print the alproject version

Run \`alproject --guide\` for configuration and operational procedures.
`;
}

export function renderProjectList(list: ProjectList): string {
  const lines = ["Projects:"];
  if (list.projects.length === 0) lines.push("  (none)");
  for (const project of list.projects) {
    lines.push(
      `- Name: ${renderOutputValue(project.name)}`,
      `  Main path: ${renderOutputValue(project.path)}`,
      `  Parent: ${renderOutputValue(project.parent)}`,
      `  Status: ${statusLabels[project.status]}`,
      `  Workspaces: ${
        project.workspaces.length === 0
          ? "(none)"
          : project.workspaces.map(renderOutputValue).join(", ")
      }`,
    );
    if (project.ports !== undefined) {
      lines.push(
        `  Base port: ${project.ports.basePort}`,
        `  Port range: ${project.ports.basePort}..${project.ports.endPort}`,
      );
    }
  }
  lines.push("", "Additional directories:");
  if (list.additionalDirectories.length === 0) lines.push("  (none)");
  for (const group of list.additionalDirectories) {
    lines.push(`- Parent: ${renderOutputValue(group.parent)}`);
    for (const directory of group.directories) {
      lines.push(`  - ${renderOutputValue(directory)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function renderProjectListJson(list: ProjectList): string {
  return `${escapeAdditionalJsonCharacters(JSON.stringify(list, undefined, 2))}\n`;
}

function renderProjectStatus(status: ProjectDetails): string {
  const lines = [
    "Project:",
    `  Name: ${renderOutputValue(status.name)}`,
    `  Main path: ${renderOutputValue(status.path)}`,
    `  Status: ${statusLabels[status.status]}`,
    `  Remote host: ${status.remoteHost === null ? "(none)" : renderOutputValue(status.remoteHost)}`,
  ];
  if (status.ports === null) {
    lines.push("  Port allocation: (none)");
  } else {
    lines.push(
      `  Base port: ${status.ports.basePort}`,
      `  Port range: ${status.ports.basePort}..${status.ports.endPort}`,
      `  Ports per workspace: ${status.ports.portsPerWorkspace}`,
      `  Maximum workspaces: ${status.ports.maxWorkspaces}`,
    );
  }
  lines.push("  Worktrees:");
  if (status.worktrees.length === 0) lines.push("    (none)");
  for (const worktree of status.worktrees) {
    lines.push(
      `  - Name: ${renderOutputValue(worktree.name)}`,
      `    Path: ${renderOutputValue(worktree.path)}`,
      `    Branch: ${worktree.branch === null ? "(detached)" : renderOutputValue(worktree.branch)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function renderProjectStatusJson(status: ProjectDetails): string {
  return `${escapeAdditionalJsonCharacters(JSON.stringify(status, undefined, 2))}\n`;
}

function renderRegistration(result: {
  path: string;
  ports?: { basePort: number; endPort: number };
}): string {
  const lines = [`Registered project: ${renderOutputValue(result.path)}`];
  if (result.ports !== undefined) {
    lines.push(
      `Base port: ${result.ports.basePort}`,
      `Port range: ${result.ports.basePort}..${result.ports.endPort}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function renderOutputValue(value: string): string {
  return escapeAdditionalJsonCharacters(JSON.stringify(value));
}

function escapeControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    if (!isControlCharacter(character, true)) return character;
    const jsonEscape = JSON.stringify(character).slice(1, -1);
    if (jsonEscape !== character) return jsonEscape;
    return unicodeEscape(character);
  }).join("");
}

function escapeAdditionalJsonCharacters(value: string): string {
  return Array.from(value, (character) =>
    isControlCharacter(character, false) ? unicodeEscape(character) : character,
  ).join("");
}

function isControlCharacter(character: string, includeC0: boolean): boolean {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) return false;
  return (
    (includeC0 && codePoint <= 0x1f) ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029
  );
}

function unicodeEscape(character: string): string {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) throw new Error("Cannot escape an empty character");
  return `\\u${codePoint.toString(16).padStart(4, "0")}`;
}
