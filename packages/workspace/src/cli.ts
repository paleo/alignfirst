import { parseArgs, type ParseArgsConfig } from "node:util";
import { ConfigError } from "./errors.js";

const DEV_SERVER_OPTIONS: Record<string, OptionDef> = {
  help: { type: "boolean", short: "h", description: "Show this help message" },
  stop: { type: "boolean", description: "Stop dev servers in the current worktree" },
  list: { type: "boolean", description: "List active dev-servers across all worktrees" },
  all: { type: "boolean", description: "Apply --stop to every active dev-server" },
  evict: { type: "boolean", description: "Evict the oldest dev-server when the cap is reached" },
  restart: {
    type: "boolean",
    description: "If a dev-server is already running in this worktree, stop it first, then start",
  },
};

export type WorkspaceCommand =
  | {
      kind: "setup";
      branch?: string;
      newBranch: boolean;
      owner?: string;
      slot?: string;
      force: boolean;
      wait: boolean;
    }
  | { kind: "remove"; branch?: string; noRemoteCheck: boolean }
  | { kind: "list" }
  | { kind: "info"; slot?: string }
  | { kind: "wait"; slot?: string }
  | { kind: "set-owner"; name: string }
  | { kind: "finalize"; slot: string; force: boolean }
  | { kind: "help" };

export interface ParsedWorkspaceArgs {
  command: WorkspaceCommand;
  verbose: boolean;
}

export function parseWorkspaceArgs(argv: string[] = process.argv.slice(2)): ParsedWorkspaceArgs {
  const [subcommand, ...tokens] = argv;
  if (subcommand === undefined || subcommand === "--help" || subcommand === "-h") {
    return { command: { kind: "help" }, verbose: false };
  }
  try {
    return parseSubcommand(subcommand, tokens);
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError(`Error: ${(err as Error).message}`);
  }
}

function parseSubcommand(subcommand: string, tokens: string[]): ParsedWorkspaceArgs {
  switch (subcommand) {
    case "setup":
      return parseSetup(tokens);
    case "remove":
      return parseRemove(tokens);
    case "list":
      return parseList(tokens);
    case "info":
      return parseInfo(tokens);
    case "wait":
      return parseWait(tokens);
    case "set-owner":
      return parseSetOwner(tokens);
    case "__finalize":
      return parseFinalize(tokens);
    default:
      throw new ConfigError(`Error: Unknown command "${subcommand}". Run \`workspace --help\`.`);
  }
}

function parseSetup(tokens: string[]): ParsedWorkspaceArgs {
  const { values, positionals } = parseArgs({
    args: tokens,
    options: {
      "new-branch": { type: "boolean", short: "c" },
      owner: { type: "string" },
      slot: { type: "string", short: "s" },
      force: { type: "boolean" },
      wait: { type: "boolean" },
      verbose: { type: "boolean", short: "v" },
    },
    allowPositionals: true,
    strict: true,
  });
  const branch = takeOptionalPositional(positionals, "setup");
  const newBranch = values["new-branch"] ?? false;
  if (newBranch && branch === undefined) {
    throw new ConfigError("Error: `workspace setup <branch> -c` requires a branch name.");
  }
  return {
    command: {
      kind: "setup",
      branch,
      newBranch,
      owner: values.owner,
      slot: values.slot,
      force: values.force ?? false,
      wait: values.wait ?? false,
    },
    verbose: values.verbose ?? false,
  };
}

function parseRemove(tokens: string[]): ParsedWorkspaceArgs {
  const { values, positionals } = parseArgs({
    args: tokens,
    options: {
      "no-remote-check": { type: "boolean" },
      verbose: { type: "boolean", short: "v" },
    },
    allowPositionals: true,
    strict: true,
  });
  const branch = takeOptionalPositional(positionals, "remove");
  return {
    command: { kind: "remove", branch, noRemoteCheck: values["no-remote-check"] ?? false },
    verbose: values.verbose ?? false,
  };
}

function parseList(tokens: string[]): ParsedWorkspaceArgs {
  const { values, positionals } = parseArgs({
    args: tokens,
    options: { verbose: { type: "boolean", short: "v" } },
    allowPositionals: true,
    strict: true,
  });
  rejectPositionals(positionals, "list");
  return { command: { kind: "list" }, verbose: values.verbose ?? false };
}

function parseInfo(tokens: string[]): ParsedWorkspaceArgs {
  const { values, positionals } = parseArgs({
    args: tokens,
    options: {
      slot: { type: "string", short: "s" },
      verbose: { type: "boolean", short: "v" },
    },
    allowPositionals: true,
    strict: true,
  });
  rejectPositionals(positionals, "info");
  return { command: { kind: "info", slot: values.slot }, verbose: values.verbose ?? false };
}

function parseWait(tokens: string[]): ParsedWorkspaceArgs {
  const { values, positionals } = parseArgs({
    args: tokens,
    options: {
      slot: { type: "string", short: "s" },
      verbose: { type: "boolean", short: "v" },
    },
    allowPositionals: true,
    strict: true,
  });
  rejectPositionals(positionals, "wait");
  return { command: { kind: "wait", slot: values.slot }, verbose: values.verbose ?? false };
}

function parseSetOwner(tokens: string[]): ParsedWorkspaceArgs {
  const { values, positionals } = parseArgs({
    args: tokens,
    options: { verbose: { type: "boolean", short: "v" } },
    allowPositionals: true,
    strict: true,
  });
  const name = takeRequiredPositional(positionals, "set-owner", "name");
  return { command: { kind: "set-owner", name }, verbose: values.verbose ?? false };
}

function parseFinalize(tokens: string[]): ParsedWorkspaceArgs {
  const { values, positionals } = parseArgs({
    args: tokens,
    options: { force: { type: "boolean" } },
    allowPositionals: true,
    strict: true,
  });
  const slot = takeRequiredPositional(positionals, "__finalize", "slot");
  return { command: { kind: "finalize", slot, force: values.force ?? false }, verbose: false };
}

function takeOptionalPositional(positionals: string[], command: string): string | undefined {
  if (positionals.length > 1) {
    throw new ConfigError(
      `Error: \`workspace ${command}\` accepts at most one positional argument.`,
    );
  }
  return positionals[0];
}

function takeRequiredPositional(positionals: string[], command: string, label: string): string {
  if (positionals.length !== 1) {
    throw new ConfigError(`Error: \`workspace ${command}\` requires exactly one ${label}.`);
  }
  return positionals[0];
}

function rejectPositionals(positionals: string[], command: string): void {
  if (positionals.length > 0) {
    throw new ConfigError(`Error: \`workspace ${command}\` takes no positional arguments.`);
  }
}

export function printWorkspaceHelp(): void {
  console.log(
    [
      "Usage: workspace <command> [options]",
      "",
      "Manage workspaces: a git worktree plus its own dev setup (ports, config, database, dev server).",
      "",
      "Commands:",
      "  setup [<branch>] [-c|--new-branch] [--owner <name>] [-s|--slot <port>] [--force] [--wait]",
      "      Set up the workspace. With <branch>, create a sibling worktree for it",
      "      (add -c to create the branch first). Without, set up the current worktree",
      "      (idempotent; bootstrap and retry path).",
      "      Finalize runs in the background; add --wait to block until it reaches READY.",
      "  remove [<branch>] [--no-remote-check]",
      "      Remove a workspace by branch, or the current one when omitted.",
      "  list",
      "      List all registered workspaces (slot, status, branch, path, owner, created).",
      "  info [-s|--slot <port>]",
      "      Print a workspace summary (ports, branch, readiness).",
      "  wait [-s|--slot <port>]",
      "      Block until the background finalize reaches READY (exit 0) or FAILED (exit 1).",
      "  set-owner <name>",
      "      Update the current workspace's owner (no rebuild).",
      "",
      "Global options:",
      "  -v, --verbose   Show intermediate output.",
    ].join("\n"),
  );
}

export interface DevServerArgs {
  help?: boolean;
  stop?: boolean;
  list?: boolean;
  all?: boolean;
  evict?: boolean;
  restart?: boolean;
}

export function parseDevServerArgs(argv?: string[]): DevServerArgs {
  return parseOptions<DevServerArgs>(argv, DEV_SERVER_OPTIONS);
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

export function validateDevServerFlags(args: DevServerArgs): void {
  if (args.all && !args.stop) {
    throw new ConfigError("Error: --all requires --stop.");
  }
  if (args.list && (args.stop || args.all)) {
    throw new ConfigError("Error: --list is mutually exclusive with --stop and --all.");
  }
  if (args.evict && (args.stop || args.list || args.all)) {
    const conflict = args.stop ? "--stop" : args.list ? "--list" : "--all";
    throw new ConfigError(`Error: --evict cannot be combined with ${conflict}.`);
  }
  if (args.restart && (args.stop || args.list || args.all)) {
    const conflict = args.stop ? "--stop" : args.list ? "--list" : "--all";
    throw new ConfigError(`Error: --restart cannot be combined with ${conflict}.`);
  }
}

interface OptionDef {
  type: "boolean" | "string";
  short?: string;
  arg?: string;
  description: string;
}

function parseOptions<T>(argv: string[] | undefined, options: Record<string, OptionDef>): T {
  const cfg: ParseArgsConfig = { options: options as ParseArgsConfig["options"], strict: true };
  if (argv) cfg.args = argv;
  const { values } = parseArgs(cfg);
  return values as T;
}

function formatHelp(usage: string, intro: string, options: Record<string, OptionDef>): string {
  const lines = [`Usage: ${usage}`, "", intro, ""];
  for (const [name, opt] of Object.entries(options)) {
    if (opt.description === "") continue;
    const shortFlag = opt.short ? `-${opt.short}, ` : "";
    const argSuffix = opt.arg ? ` <${opt.arg}>` : "";
    const flag = `${shortFlag}--${name}${argSuffix}`;
    lines.push(`  ${flag.padEnd(28)} ${opt.description}`);
  }
  return lines.join("\n");
}
