import { parseArgs } from "node:util";
import { ConfigError } from "./errors.js";

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
  if (subcommand === "--help" || subcommand === "-h") {
    return { command: { kind: "help" }, verbose: false };
  }
  if (subcommand === undefined) throw new ConfigError("No command given.");
  try {
    return parseSubcommand(subcommand, tokens);
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError((err as Error).message);
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
      throw new ConfigError(`Unknown command "${subcommand}". Run \`workspace --help\`.`);
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
    throw new ConfigError("`workspace setup <branch> -c` requires a branch name.");
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
    throw new ConfigError(`\`workspace ${command}\` accepts at most one positional argument.`);
  }
  return positionals[0];
}

function takeRequiredPositional(positionals: string[], command: string, label: string): string {
  if (positionals.length !== 1) {
    throw new ConfigError(`\`workspace ${command}\` requires exactly one ${label}.`);
  }
  return positionals[0];
}

function rejectPositionals(positionals: string[], command: string): void {
  if (positionals.length > 0) {
    throw new ConfigError(`\`workspace ${command}\` takes no positional arguments.`);
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

export type DevCommand =
  | { kind: "foreground"; evict: boolean; restart: boolean }
  | { kind: "up"; evict: boolean; restart: boolean }
  | { kind: "down"; all: boolean }
  | { kind: "list" }
  | { kind: "help" };

export function parseDevArgs(argv: string[] = process.argv.slice(2)): DevCommand {
  const [first] = argv;
  if (first === "--help" || first === "-h") return { kind: "help" };
  try {
    if (first === undefined || first.startsWith("-")) return parseForeground(argv);
    return parseDevSubcommand(first, argv.slice(1));
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError((err as Error).message);
  }
}

function parseDevSubcommand(subcommand: string, tokens: string[]): DevCommand {
  switch (subcommand) {
    case "up":
      return parseUp(tokens);
    case "down":
      return parseDown(tokens);
    case "list":
      return parseDevList(tokens);
    default:
      throw new ConfigError(`Unknown command "${subcommand}". Run \`dev --help\`.`);
  }
}

function parseForeground(tokens: string[]): DevCommand {
  const { evict, restart } = parseEvictRestart(tokens, "dev");
  return { kind: "foreground", evict, restart };
}

function parseUp(tokens: string[]): DevCommand {
  const { evict, restart } = parseEvictRestart(tokens, "dev up");
  return { kind: "up", evict, restart };
}

function parseEvictRestart(
  tokens: string[],
  command: string,
): { evict: boolean; restart: boolean } {
  const { values, positionals } = parseArgs({
    args: tokens,
    options: { evict: { type: "boolean" }, restart: { type: "boolean" } },
    allowPositionals: true,
    strict: true,
  });
  rejectDevPositionals(positionals, command);
  return { evict: values.evict ?? false, restart: values.restart ?? false };
}

function parseDown(tokens: string[]): DevCommand {
  const { values, positionals } = parseArgs({
    args: tokens,
    options: { all: { type: "boolean" } },
    allowPositionals: true,
    strict: true,
  });
  rejectDevPositionals(positionals, "dev down");
  return { kind: "down", all: values.all ?? false };
}

function parseDevList(tokens: string[]): DevCommand {
  const { positionals } = parseArgs({
    args: tokens,
    options: {},
    allowPositionals: true,
    strict: true,
  });
  rejectDevPositionals(positionals, "dev list");
  return { kind: "list" };
}

function rejectDevPositionals(positionals: string[], command: string): void {
  if (positionals.length > 0) {
    throw new ConfigError(`\`${command}\` takes no positional arguments.`);
  }
}

export function printDevHelp(): void {
  console.log(
    [
      "Usage: dev [command] [options]",
      "",
      "Start, stop, or list dev-server processes for worktree-based environments.",
      "",
      "Commands:",
      "  dev               Start in the foreground; holds the terminal, stops on CTRL+C.",
      "  dev up            Start in the background and return once ready.",
      "  dev down [--all]  Stop this worktree's dev-server, or every dev-server with --all.",
      "  dev list          List active dev-servers across all worktrees.",
      "  dev --help        Show this help message.",
      "",
      "Options (dev, dev up):",
      "  --evict     Evict the oldest dev-server when the cap is reached.",
      "  --restart   If a dev-server is already running here, stop it first, then start.",
    ].join("\n"),
  );
}
