import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { ConfigError } from "./errors.js";

export type WorkspaceCommand =
  | {
      kind: "setup";
      branch?: string;
      newBranch: boolean;
      from?: string;
      force: boolean;
      go: boolean;
      dedupe: boolean;
      detached: boolean;
    }
  | { kind: "remove"; selector: WorkspaceSelector; force: boolean }
  | { kind: "list" }
  | { kind: "prune" }
  | { kind: "status"; selector: WorkspaceSelector }
  | { kind: "wait"; selector: WorkspaceSelector }
  | { kind: "finalize"; force: boolean }
  | { kind: "guide" }
  | { kind: "help" }
  | { kind: "version" };

/** Picks an existing workspace. Empty = the current worktree. */
export interface WorkspaceSelector {
  /** Path to the target worktree, or just its directory basename. */
  dir?: string;
}

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
  if (subcommand === "--version" || subcommand === "-v") {
    return { command: { kind: "version" }, verbose: false };
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
      from: { type: "string" },
      force: { type: "boolean" },
      go: { type: "boolean" },
      dedupe: { type: "boolean" },
      detached: { type: "boolean", short: "d" },
      verbose: { type: "boolean" },
    },
    allowPositionals: true,
    strict: true,
  });
  const branch = takeOptionalPositional(positionals, "setup");
  const newBranch = values["new-branch"] ?? false;
  const go = values.go ?? false;
  const dedupe = values.dedupe ?? false;
  if (newBranch && branch === undefined) {
    throw new ConfigError("`workspace setup -c <branch>` requires a branch name.");
  }
  if (values.from !== undefined && !newBranch) {
    throw new ConfigError("`--from` requires `-c`/`--new-branch`.");
  }
  if (dedupe && !newBranch) {
    throw new ConfigError("`--dedupe` requires `-c`/`--new-branch`.");
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
      force: values.force ?? false,
      go,
      dedupe,
      detached: values.detached ?? false,
    },
    verbose: values.verbose ?? false,
  };
}

function parseRemove(tokens: string[]): ParsedWorkspaceArgs {
  const { values, positionals } = parseArgs({
    args: tokens,
    options: {
      force: { type: "boolean" },
      verbose: { type: "boolean" },
    },
    allowPositionals: true,
    strict: true,
  });
  const dir = takeOptionalPositional(positionals, "remove");
  return {
    command: {
      kind: "remove",
      selector: { dir },
      force: values.force ?? false,
    },
    verbose: values.verbose ?? false,
  };
}

function parseList(tokens: string[]): ParsedWorkspaceArgs {
  const { values, positionals } = parseArgs({
    args: tokens,
    options: { verbose: { type: "boolean" } },
    allowPositionals: true,
    strict: true,
  });
  rejectPositionals(positionals, "list");
  return { command: { kind: "list" }, verbose: values.verbose ?? false };
}

function parsePrune(tokens: string[]): ParsedWorkspaceArgs {
  const { values, positionals } = parseArgs({
    args: tokens,
    options: { verbose: { type: "boolean" } },
    allowPositionals: true,
    strict: true,
  });
  rejectPositionals(positionals, "prune");
  return { command: { kind: "prune" }, verbose: values.verbose ?? false };
}

function parseStatus(tokens: string[]): ParsedWorkspaceArgs {
  const { values, positionals } = parseArgs({
    args: tokens,
    options: { verbose: { type: "boolean" } },
    allowPositionals: true,
    strict: true,
  });
  const dir = takeOptionalPositional(positionals, "status");
  return {
    command: { kind: "status", selector: { dir } },
    verbose: values.verbose ?? false,
  };
}

function parseWait(tokens: string[]): ParsedWorkspaceArgs {
  const { values, positionals } = parseArgs({
    args: tokens,
    options: { verbose: { type: "boolean" } },
    allowPositionals: true,
    strict: true,
  });
  const dir = takeOptionalPositional(positionals, "wait");
  return {
    command: { kind: "wait", selector: { dir } },
    verbose: values.verbose ?? false,
  };
}

function parseFinalize(tokens: string[]): ParsedWorkspaceArgs {
  const { values, positionals } = parseArgs({
    args: tokens,
    options: { force: { type: "boolean" } },
    allowPositionals: true,
    strict: true,
  });
  rejectPositionals(positionals, "__finalize");
  return { command: { kind: "finalize", force: values.force ?? false }, verbose: false };
}

function takeOptionalPositional(positionals: string[], command: string): string | undefined {
  if (positionals.length > 1) {
    throw new ConfigError(`\`workspace ${command}\` accepts at most one positional argument.`);
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
      "Manage workspaces: a git worktree plus its own dev setup (config files, and optionally",
      "ports, database, dev server).",
      "",
      "Commands:",
      "  setup [-c|--new-branch] [<branch>] [--dedupe] [--from <ref>] [--force] [-d|--detached] [--go]",
      "      Set up the workspace. With <branch>, create a sibling worktree for it",
      "      (add -c to create the branch first). Without, set up the current worktree",
      "      (idempotent; bootstrap and retry path).",
      "      With -c, the new branch starts at the current worktree's HEAD, or at <ref> with --from.",
      "      --dedupe: when the branch name is taken, append -2, -3… instead of failing",
      "      (without it, a taken name is an error).",
      "      Blocks until setup reaches READY (or FAILED), showing a progress ticker.",
      "      -d|--detached: return once the worktree exists; setup continues in the background,",
      "      join it with `wait`.",
      "      With --go, drop into an interactive shell in the new worktree (exit to return);",
      "      entered once READY, or immediately with -d. Requires a branch and $SHELL.",
      "  remove [<dir>] [--force]",
      "      Remove a workspace, selected by directory (path or basename);",
      "      the current worktree when omitted. Refuses on uncommitted changes unless --force.",
      "  list",
      "      List all registered workspaces (name, status, branch, path, created).",
      "  prune",
      "      Heal orphaned workspaces (worktree deleted out-of-band): stop their dev-servers",
      "      and drop their registry entries, then run `git worktree prune`.",
      "  status [<dir>]",
      "      Print a workspace summary (branch, readiness, ports, dev-server).",
      "      Selected by directory (path or basename); the current worktree when omitted.",
      "  wait [<dir>]",
      "      Block until setup reaches READY (exit 0) or FAILED (exit 1).",
      "",
      "Global options:",
      "      --verbose       Show intermediate output.",
      "      --guide         Print the full workspace + dev-server operating guide.",
      "  -h, --help          Show this help message.",
      "  -v, --version       Print the workspace version.",
    ].join("\n"),
  );
}

export function printWorkspaceVersion(): void {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as {
    version?: string;
  };
  if (!pkg.version) throw new ConfigError("workspace: package.json is missing 'version'");
  console.log(pkg.version);
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
