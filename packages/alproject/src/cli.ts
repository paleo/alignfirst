import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { parseArgs } from "node:util";

import { readConfig, readConfigIfPresent } from "./config.js";
import { buildProjectList, type ProjectList, type ProjectStatus } from "./discovery.js";
import { renderGuide } from "./guide.js";
import { registerProject, unregisterProject } from "./mutations.js";
import { readRegistry } from "./registry.js";

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
  command?: string;
  guide: boolean;
  help: boolean;
  maxWorkspaces?: number;
  path?: string;
  portsPerWorkspace?: number;
  version: boolean;
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
    stderr.write(`${errorMessage(error)}\n`);
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
      stdout.write(ensureTrailingNewline(renderGuide(config?.root)));
      return 0;
    }
    if (args.command === undefined) {
      stdout.write(renderHelp());
      return 0;
    }
    const config = readConfig(home);
    if (args.command === "list") {
      stdout.write(renderProjectList(buildProjectList(config, readRegistry(config))));
      return 0;
    }
    if (args.command === "register" && args.path !== undefined) {
      const result = await registerProject(config, args.path, {
        maxWorkspaces: args.maxWorkspaces,
        portsPerWorkspace: args.portsPerWorkspace,
      });
      stdout.write(renderRegistration(result));
      return 0;
    }
    if (args.command === "unregister" && args.path !== undefined) {
      const path = await unregisterProject(config, args.path);
      stdout.write(`Unregistered project: ${path}\n`);
      return 0;
    }
    throw new Error(`Unknown command: ${args.command}`);
  } catch (error) {
    stderr.write(`${errorMessage(error)}\n`);
    return 1;
  }
}

export function parseAlprojectArgs(argv: string[]): AlprojectArgs {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    args: argv.slice(2),
    options: {
      guide: { default: false, type: "boolean" },
      help: { default: false, short: "h", type: "boolean" },
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
    if (values["ports-per-workspace"] !== undefined || values["max-workspaces"] !== undefined) {
      throw new Error(`${selectedModes[0]} does not accept port options`);
    }
    return {
      guide: values.guide === true,
      help: values.help === true,
      version: values.version === true,
    };
  }

  const [command, path, ...extraPaths] = positionals;
  if (command === undefined) {
    return { guide: false, help: false, version: false };
  }
  if (!isCommand(command)) throw new Error(`Unknown command: ${command}`);
  validateCommandPaths(command, path, extraPaths);
  validatePortOptionPlacement(command, values);
  const portsPerWorkspace = parsePositiveInteger(
    "--ports-per-workspace",
    values["ports-per-workspace"],
  );
  const maxWorkspaces = parsePositiveInteger("--max-workspaces", values["max-workspaces"]);
  if ((portsPerWorkspace === undefined) !== (maxWorkspaces === undefined)) {
    throw new Error("--ports-per-workspace and --max-workspaces must be provided together");
  }
  return {
    command,
    guide: false,
    help: false,
    maxWorkspaces,
    path,
    portsPerWorkspace,
    version: false,
  };
}

function isCommand(value: string): value is "list" | "register" | "unregister" {
  return value === "list" || value === "register" || value === "unregister";
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

function validatePortOptionPlacement(
  command: string,
  values: { "max-workspaces"?: string; "ports-per-workspace"?: string },
): void {
  if (
    command !== "register" &&
    (values["ports-per-workspace"] !== undefined || values["max-workspaces"] !== undefined)
  ) {
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
  alproject list
  alproject register <path> [--ports-per-workspace <n> --max-workspaces <n>]
  alproject unregister <path>

Options:
  --guide              Print the complete guide
  -h, --help           Print this help
  -v, --version        Print the alproject version

Run \`alproject --guide\` for configuration and operational procedures.
`;
}

export function renderProjectList(list: ProjectList): string {
  const lines = ["Projects:"];
  if (list.projects.length === 0) lines.push("  (none)");
  for (const project of list.projects) {
    lines.push(
      `- Name: ${project.name}`,
      `  Main path: ${project.path}`,
      `  Parent: ${project.parent}`,
      `  Status: ${statusLabels[project.status]}`,
      `  Workspaces: ${project.workspaces.length === 0 ? "(none)" : project.workspaces.join(", ")}`,
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
    lines.push(`- Parent: ${group.parent}`);
    for (const directory of group.directories) lines.push(`  - ${directory}`);
  }
  return `${lines.join("\n")}\n`;
}

function renderRegistration(result: {
  path: string;
  ports?: { basePort: number; endPort: number };
}): string {
  const lines = [`Registered project: ${result.path}`];
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
