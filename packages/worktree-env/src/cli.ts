import { parseArgs, type ParseArgsConfig } from "node:util";

import { ConfigError } from "./errors.js";

interface OptionDef {
  type: "boolean" | "string";
  short?: string;
  arg?: string;
  description: string;
}

const SETUP_OPTIONS: Record<string, OptionDef> = {
  help: { type: "boolean", short: "h", description: "Show this help message" },
  use: {
    type: "string",
    arg: "branch",
    description: "Create a worktree for an existing branch, then set up the local environment",
  },
  create: {
    type: "string",
    arg: "branch",
    description:
      "Create a new branch + worktree, then set up the local environment. If the branch already exists, appends a numeric suffix (-2, -3, ...)",
  },
  here: {
    type: "boolean",
    description: "Set up the local environment in the current linked worktree",
  },
  owner: {
    type: "string",
    arg: "name",
    description: "Owner of the slot (free-form label, optional)",
  },
  "set-owner": {
    type: "string",
    arg: "name",
    description: "Update the owner of the current linked worktree's slot (no rebuild)",
  },
  remove: {
    type: "string",
    arg: "branch",
    description: "Remove a worktree by branch name (stop dev server, free slot, delete directory)",
  },
  "remove-here": {
    type: "boolean",
    description:
      "Remove the current linked worktree (same as --remove, but for the worktree you are in)",
  },
  "no-remote-check": {
    type: "boolean",
    description:
      "Skip remote branch verification when removing (use with --remove or --remove-here)",
  },
  slot: {
    type: "string",
    short: "s",
    arg: "port",
    description: "Use a specific slot instead of auto-assigning",
  },
  force: {
    type: "boolean",
    description: "Overwrite existing config files and re-provision the database",
  },
  verbose: { type: "boolean", short: "v", description: "Show intermediate output" },
};

const DEV_SERVER_OPTIONS: Record<string, OptionDef> = {
  help: { type: "boolean", short: "h", description: "Show this help message" },
  stop: { type: "boolean", description: "Stop dev servers in the current worktree" },
  list: { type: "boolean", description: "List active dev-servers across all worktrees" },
  all: { type: "boolean", description: "Apply --stop to every active dev-server" },
};

export interface SetupArgs {
  help?: boolean;
  use?: string;
  create?: string;
  here?: boolean;
  owner?: string;
  "set-owner"?: string;
  remove?: string;
  "remove-here"?: boolean;
  "no-remote-check"?: boolean;
  slot?: string;
  force?: boolean;
  verbose?: boolean;
}

export interface DevServerArgs {
  help?: boolean;
  stop?: boolean;
  list?: boolean;
  all?: boolean;
}

function parseOptions<T>(argv: string[] | undefined, options: Record<string, OptionDef>): T {
  const cfg: ParseArgsConfig = { options: options as ParseArgsConfig["options"], strict: true };
  if (argv) cfg.args = argv;
  const { values } = parseArgs(cfg);
  return values as T;
}

export function parseSetupArgs(argv?: string[]): SetupArgs {
  return parseOptions<SetupArgs>(argv, SETUP_OPTIONS);
}

export function parseDevServerArgs(argv?: string[]): DevServerArgs {
  return parseOptions<DevServerArgs>(argv, DEV_SERVER_OPTIONS);
}

function formatHelp(usage: string, intro: string, options: Record<string, OptionDef>): string {
  const lines = [`Usage: ${usage}`, "", intro, ""];
  for (const [name, opt] of Object.entries(options)) {
    const shortFlag = opt.short ? `-${opt.short}, ` : "";
    const argSuffix = opt.arg ? ` <${opt.arg}>` : "";
    const flag = `${shortFlag}--${name}${argSuffix}`;
    lines.push(`  ${flag.padEnd(28)} ${opt.description}`);
  }
  return lines.join("\n");
}

export function printSetupHelp(): void {
  console.log(
    formatHelp(
      "setup-worktree [options]",
      "Manage worktree lifecycle: creation, local environment setup, and removal.",
      SETUP_OPTIONS,
    ),
  );
}

export function printDevServerHelp(): void {
  console.log(
    formatHelp(
      "dev-server [options]",
      "Start, stop, or list background dev-server processes.",
      DEV_SERVER_OPTIONS,
    ),
  );
}

export function isSetupMode(args: SetupArgs): boolean {
  return args.use !== undefined || args.create !== undefined || Boolean(args.here);
}

export function isRemoveMode(args: SetupArgs): boolean {
  return args.remove !== undefined || Boolean(args["remove-here"]);
}

export function isSetOwnerMode(args: SetupArgs): boolean {
  return args["set-owner"] !== undefined;
}

export function validateSetupFlags(args: SetupArgs): void {
  const modeFlags = [
    args.use,
    args.create,
    args.here,
    isRemoveMode(args),
    isSetOwnerMode(args),
  ].filter(Boolean);
  if (modeFlags.length > 1) {
    throw new ConfigError(
      "Error: --use, --create, --here, --remove, --remove-here, and --set-owner are mutually exclusive.",
    );
  }
  if (args.remove !== undefined && args["remove-here"]) {
    throw new ConfigError("Error: --remove and --remove-here are mutually exclusive.");
  }
  if ((args.slot !== undefined || args.force) && !isSetupMode(args)) {
    throw new ConfigError(
      "Error: --slot and --force can only be used with --use, --create, or --here.",
    );
  }
  if (args.owner !== undefined && !isSetupMode(args)) {
    throw new ConfigError("Error: --owner is only valid with --use, --create, or --here.");
  }
  if (args["no-remote-check"] && !isRemoveMode(args)) {
    throw new ConfigError("Error: --no-remote-check is only valid with --remove or --remove-here.");
  }
}

export function validateDevServerFlags(args: DevServerArgs): void {
  if (args.all && !args.stop) {
    throw new ConfigError("Error: --all requires --stop.");
  }
  if (args.list && (args.stop || args.all)) {
    throw new ConfigError("Error: --list is mutually exclusive with --stop and --all.");
  }
}
