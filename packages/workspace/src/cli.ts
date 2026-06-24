import { parseArgs } from "node:util";
import { ConfigError } from "./errors.js";

export type WorkspaceCommand =
  | {
      kind: "setup";
      branch?: string;
      newBranch: boolean;
      from?: string;
      owner?: string;
      slot?: string;
      force: boolean;
      wait: boolean;
      go: boolean;
    }
  | { kind: "remove"; branch?: string; force: boolean }
  | { kind: "list" }
  | { kind: "prune" }
  | { kind: "status"; slot?: string }
  | { kind: "wait"; slot?: string }
  | { kind: "set-owner"; name: string }
  | { kind: "finalize"; slot: string; force: boolean }
  | { kind: "migrate"; oldRegistryDir: string }
  | { kind: "guide" }
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
  if (subcommand === "--guide") {
    return { command: { kind: "guide" }, verbose: false };
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
    case "prune":
      return parsePrune(tokens);
    case "status":
      return parseStatus(tokens);
    case "wait":
      return parseWait(tokens);
    case "set-owner":
      return parseSetOwner(tokens);
    case "__finalize":
      return parseFinalize(tokens);
    case "migrate-0.16":
      return parseMigrate(tokens);
    default:
      throw new ConfigError(`Unknown command "${subcommand}". Run \`workspace --help\`.`);
  }
}

function parseSetup(tokens: string[]): ParsedWorkspaceArgs {
  const { values, positionals } = parseArgs({
    args: tokens,
    options: {
      "new-branch": { type: "boolean", short: "c" },
      from: { type: "string" },
      owner: { type: "string" },
      slot: { type: "string", short: "s" },
      force: { type: "boolean" },
      wait: { type: "boolean" },
      go: { type: "boolean" },
      verbose: { type: "boolean", short: "v" },
    },
    allowPositionals: true,
    strict: true,
  });
  const branch = takeOptionalPositional(positionals, "setup");
  const newBranch = values["new-branch"] ?? false;
  const go = values.go ?? false;
  if (newBranch && branch === undefined) {
    throw new ConfigError("`workspace setup <branch> -c` requires a branch name.");
  }
  if (values.from !== undefined && !newBranch) {
    throw new ConfigError("`--from` requires `-c`/`--new-branch`.");
  }
  if (go && branch === undefined) {
    throw new ConfigError("`--go` requires a branch (the worktree to enter).");
  }
  return {
    command: {
      kind: "setup",
      branch,
      newBranch,
      from: values.from,
      owner: values.owner,
      slot: values.slot,
      force: values.force ?? false,
      wait: values.wait ?? false,
      go,
    },
    verbose: values.verbose ?? false,
  };
}

function parseRemove(tokens: string[]): ParsedWorkspaceArgs {
  const { values, positionals } = parseArgs({
    args: tokens,
    options: {
      force: { type: "boolean" },
      verbose: { type: "boolean", short: "v" },
    },
    allowPositionals: true,
    strict: true,
  });
  const branch = takeOptionalPositional(positionals, "remove");
  return {
    command: { kind: "remove", branch, force: values.force ?? false },
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

function parsePrune(tokens: string[]): ParsedWorkspaceArgs {
  const { values, positionals } = parseArgs({
    args: tokens,
    options: { verbose: { type: "boolean", short: "v" } },
    allowPositionals: true,
    strict: true,
  });
  rejectPositionals(positionals, "prune");
  return { command: { kind: "prune" }, verbose: values.verbose ?? false };
}

function parseStatus(tokens: string[]): ParsedWorkspaceArgs {
  const { values, positionals } = parseArgs({
    args: tokens,
    options: {
      slot: { type: "string", short: "s" },
      verbose: { type: "boolean", short: "v" },
    },
    allowPositionals: true,
    strict: true,
  });
  rejectPositionals(positionals, "status");
  return { command: { kind: "status", slot: values.slot }, verbose: values.verbose ?? false };
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

function parseMigrate(tokens: string[]): ParsedWorkspaceArgs {
  const { values, positionals } = parseArgs({
    args: tokens,
    options: { verbose: { type: "boolean", short: "v" } },
    allowPositionals: true,
    strict: true,
  });
  const oldRegistryDir = takeRequiredPositional(positionals, "migrate-0.16", "old-registry-dir");
  return { command: { kind: "migrate", oldRegistryDir }, verbose: values.verbose ?? false };
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
      "  setup [<branch>] [-c|--new-branch] [--from <ref>] [--owner <name>] [-s|--slot <port>] [--force] [--wait] [--go]",
      "      Set up the workspace. With <branch>, create a sibling worktree for it",
      "      (add -c to create the branch first). Without, set up the current worktree",
      "      (idempotent; bootstrap and retry path).",
      "      With -c, the new branch starts at the current worktree's HEAD, or at <ref> with --from.",
      "      Finalize runs in the background; add --wait to block until it reaches READY.",
      "      With --go, drop into an interactive shell in the new worktree (exit to return);",
      "      combine with --wait to enter only once it is READY. Requires a branch and $SHELL.",
      "  remove [<branch>] [--force]",
      "      Remove a workspace by branch, or the current one when omitted.",
      "      Refuses on uncommitted changes unless --force.",
      "  list",
      "      List all registered workspaces (slot, status, branch, path, owner, created).",
      "  prune",
      "      Heal orphaned workspaces (worktree deleted out-of-band): stop their dev-servers",
      "      and drop their registry entries, then run `git worktree prune`.",
      "  status [-s|--slot <port>]",
      "      Print a workspace summary (ports, branch, readiness, dev-server).",
      "  wait [-s|--slot <port>]",
      "      Block until the background finalize reaches READY (exit 0) or FAILED (exit 1).",
      "  set-owner <name>",
      "      Update the current workspace's owner (no rebuild).",
      "",
      "Global options:",
      "  -v, --verbose   Show intermediate output.",
      "      --guide     Print the full workspace + dev-server operating guide.",
      "  -h, --help      Show this help message.",
    ].join("\n"),
  );
}

export type DevCommand =
  | { kind: "foreground"; evict: boolean; restart: boolean }
  | { kind: "up"; evict: boolean; restart: boolean }
  | { kind: "restart"; evict: boolean }
  | { kind: "down"; all: boolean }
  | { kind: "list" }
  | { kind: "status" }
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
    case "restart":
      return parseRestart(tokens);
    case "down":
      return parseDown(tokens);
    case "list":
      return parseDevList(tokens);
    case "status":
      return parseDevStatus(tokens);
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

function parseRestart(tokens: string[]): DevCommand {
  const { values, positionals } = parseArgs({
    args: tokens,
    options: { evict: { type: "boolean" } },
    allowPositionals: true,
    strict: true,
  });
  rejectDevPositionals(positionals, "dev restart");
  return { kind: "restart", evict: values.evict ?? false };
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

function parseDevStatus(tokens: string[]): DevCommand {
  const { positionals } = parseArgs({
    args: tokens,
    options: {},
    allowPositionals: true,
    strict: true,
  });
  rejectDevPositionals(positionals, "dev status");
  return { kind: "status" };
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
      "  dev               Start in the foreground, streaming logs from startup; CTRL+C stops it.",
      "                    If one is already running here, attach to its logs instead.",
      "  dev up            Start in the background and return once ready.",
      "  dev restart       Stop this worktree's dev-server if running, then start in the background.",
      "  dev down [--all]  Stop this worktree's dev-server, or every dev-server with --all.",
      "  dev list          List active dev-servers across all worktrees.",
      "  dev status        Report whether this worktree's dev-server is UP or DOWN.",
      "  dev --help        Show this help message (alias: -h).",
      "",
      "Options (dev, dev up, dev restart):",
      "  --evict     Evict the oldest dev-server when the cap is reached.",
      "Options (dev, dev up):",
      "  --restart   If a dev-server is already running here, stop it first, then start.",
    ].join("\n"),
  );
}
