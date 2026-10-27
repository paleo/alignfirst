import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { ConfigError } from "./errors.js";
import { defaultCommands, devCmd, type WorkspaceCommands, wsCmd } from "./invocation.js";

export type WorkspaceCommand =
  | {
      kind: "setup";
      branch?: string;
      path?: string;
      newBranch: boolean;
      from?: string;
      force: boolean;
      enter: boolean;
      dedupe: boolean;
      detached: boolean;
      /** Also runs the dev setup once the workspace is finalized. */
      full: boolean;
    }
  | { kind: "remove"; selector: WorkspaceSelector; force: boolean }
  | { kind: "teardown"; selector: WorkspaceSelector }
  | { kind: "list" }
  | { kind: "prune" }
  | { kind: "status"; selector: WorkspaceSelector }
  | { kind: "wait"; selector: WorkspaceSelector }
  | { kind: "finalize"; force: boolean; full: boolean }
  | { kind: "guide" }
  | { kind: "help" }
  | { kind: "version" };

/** Picks an existing workspace. Empty = the current worktree. */
export interface WorkspaceSelector {
  /** Path to the target worktree, or its registered workspace name. */
  dir?: string;
}

export interface ParsedWorkspaceArgs {
  json?: boolean;
  command: WorkspaceCommand;
  verbose: boolean;
}

export function parseWorkspaceArgs(argv: string[]): ParsedWorkspaceArgs {
  const json = argv.includes("--json");
  const parsed = parseWorkspaceTokens(argv.filter((token) => token !== "--json"));
  if (!json) return parsed;
  if (
    !["setup", "list", "status", "wait", "teardown", "remove", "prune"].includes(
      parsed.command.kind,
    )
  )
    throw new ConfigError("--json is not supported for this operation.");
  if (parsed.command.kind === "setup" && parsed.command.enter)
    throw new ConfigError("--enter cannot be combined with --json.");
  return { ...parsed, json: true };
}

function parseWorkspaceTokens(argv: string[]): ParsedWorkspaceArgs {
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
    case "teardown":
      return parseTeardown(tokens);
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
      throw new ConfigError(`Unknown command "${subcommand}". Run \`${wsCmd("--help")}\`.`);
  }
}

function parseSetup(tokens: string[]): ParsedWorkspaceArgs {
  const { values, positionals } = parseArgs({
    args: tokens,
    options: {
      "new-branch": { type: "boolean", short: "c" },
      from: { type: "string" },
      path: { type: "string" },
      force: { type: "boolean" },
      enter: { type: "boolean" },
      dedupe: { type: "boolean" },
      detached: { type: "boolean", short: "d" },
      full: { type: "boolean" },
      verbose: { type: "boolean" },
    },
    allowPositionals: true,
    strict: true,
  });
  const branch = takeOptionalPositional(positionals, "setup");
  const newBranch = values["new-branch"] ?? false;
  const enter = values.enter ?? false;
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
  if (enter && branch === undefined) {
    throw new ConfigError("`--enter` requires a branch (the worktree to enter).");
  }
  return {
    command: {
      kind: "setup",
      branch,
      ...(values.path === undefined ? {} : { path: values.path }),
      newBranch,
      from: values.from,
      force: values.force ?? false,
      enter,
      dedupe,
      detached: values.detached ?? false,
      full: values.full ?? false,
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

function parseTeardown(tokens: string[]): ParsedWorkspaceArgs {
  const { values, positionals } = parseArgs({
    args: tokens,
    options: { verbose: { type: "boolean" } },
    allowPositionals: true,
    strict: true,
  });
  const dir = takeOptionalPositional(positionals, "teardown");
  return {
    command: { kind: "teardown", selector: { dir } },
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
    options: {
      force: { type: "boolean" },
      full: { type: "boolean" },
      verbose: { type: "boolean" },
    },
    allowPositionals: true,
    strict: true,
  });
  rejectPositionals(positionals, "__finalize");
  return {
    command: { kind: "finalize", force: values.force ?? false, full: values.full ?? false },
    verbose: values.verbose ?? false,
  };
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

export function renderWorkspaceHelp(commands: WorkspaceCommands = defaultCommands): string {
  return [
    `Usage: ${commands.workspace.withArgs} <command> [options]`,
    "",
    "Manage workspaces: a git worktree plus its own dev setup (config files, and optionally",
    "ports, database, dev server).",
    "",
    "Commands:",
    "  setup [-c|--new-branch] [<branch>] [--path <path>] [--dedupe] [--from <ref>] [--force] [-d|--detached] [--enter] [--full]",
    "      --path selects a new destination with a branch, or an exact existing root without one.",
    "      Requires usable effective plans and ignored, untracked .local-wt runtime storage.",
    "      Without a manifest, preparation is synchronous and protocol-ready only.",
    "      Set up the workspace. With <branch>, create a sibling worktree for it",
    "      (add -c to create the branch first). Without, set up the current worktree",
    "      (idempotent; bootstrap and retry path).",
    "      With -c, the new branch starts at the current worktree's HEAD, or at <ref> with --from.",
    "      --dedupe: when the branch name is taken, append -2, -3… instead of failing",
    "      (without it, a taken name is an error).",
    "      Blocks until setup reaches READY (or FAILED), showing a progress ticker.",
    "      -d|--detached: return once the worktree exists; setup continues in the background,",
    "      join it with `wait`.",
    "      With --enter, drop into an interactive shell in the new worktree (exit to return);",
    "      entered once READY, or immediately with -d. Requires a branch and $SHELL.",
    "      --full: also run the dev setup (ports, run files, infrastructure); a dev failure leaves",
    "      the workspace ready.",
    "  remove [<dir>] [--force]",
    "      Remove a workspace, selected by path or registered name;",
    "      the current worktree when omitted. Refuses on uncommitted changes unless --force.",
    "  teardown [<dir>] [--verbose]",
    "      Purge configured infrastructure and drop the target's records and ports.",
    "      Keep worktree files and Git registration. Select by path or registered name;",
    "      the current worktree when omitted. Supports main and linked worktrees.",
    "  list",
    "      List Git worktrees and registered workspaces, including unprepared trees and orphans.",
    "  prune",
    "      Heal orphaned workspaces (worktree deleted out-of-band): stop their dev-servers",
    "      and drop their registry entries, then run `git worktree prune`.",
    "  status [<dir>]",
    "      Print a workspace summary (branch, readiness, allocated ports, dev-server).",
    "      Selected by path or registered name; the current worktree when omitted.",
    "  wait [<dir>]",
    "      Block until setup reaches READY (exit 0) or FAILED (exit 1).",
    "",
    "Global options:",
    "      --verbose       Show intermediate output.",
    "      --json          One result document (setup/list/status/wait/teardown/remove/prune).",

    "      --guide         Print the full workspace + dev-server operating guide.",
    "  -h, --help          Show this help message.",
    "  -v, --version       Print the workspace version.",
  ].join("\n");
}

export function workspaceVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as {
    version?: string;
  };
  if (!pkg.version) throw new ConfigError("workspace: package.json is missing 'version'");
  return pkg.version;
}

export type DevCommand =
  | { kind: "foreground"; evict: boolean; restart: boolean }
  | { kind: "up"; evict: boolean; restart: boolean }
  | { kind: "restart"; evict: boolean }
  | { kind: "down"; all: boolean }
  | { kind: "list" }
  | { kind: "status" }
  | { kind: "setup"; force: boolean; resetPorts: boolean; fromFinalize: boolean; verbose?: boolean }
  | { kind: "help" };

export function parseDevArgs(argv: string[]): DevCommand {
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
    case "setup":
      return parseDevSetup(tokens);
    default:
      throw new ConfigError(`Unknown command "${subcommand}". Run \`${devCmd("--help")}\`.`);
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

/** `--from-finalize` is internal: only the finalize child of `workspace setup --full` passes it. */
function parseDevSetup(tokens: string[]): DevCommand {
  const { values, positionals } = parseArgs({
    args: tokens,
    options: {
      force: { type: "boolean" },
      "reset-ports": { type: "boolean" },
      "from-finalize": { type: "boolean" },
      verbose: { type: "boolean" },
    },
    allowPositionals: true,
    strict: true,
  });
  rejectDevPositionals(positionals, "dev setup");
  return {
    kind: "setup",
    force: values.force ?? false,
    resetPorts: values["reset-ports"] ?? false,
    fromFinalize: values["from-finalize"] ?? false,
    verbose: values.verbose,
  };
}

function rejectDevPositionals(positionals: string[], command: string): void {
  if (positionals.length > 0) {
    throw new ConfigError(`\`${command}\` takes no positional arguments.`);
  }
}

export function renderDevHelp(commands: WorkspaceCommands = defaultCommands): string {
  return [
    `Usage: ${commands.dev.withArgs} [command] [options]`,
    "",
    "Start, stop, or list dev-server processes for worktree-based environments.",
    "",
    "Commands:",
    `  ${commands.dev.base}               Start in the foreground, streaming logs from startup; CTRL+C stops it.`,
    "                    If one is already running here, attach to its logs instead.",
    "  dev up            Start in the background and return once ready.",
    "  dev restart       Stop this worktree's dev-server if running, then start in the background.",
    "  dev down [--all]  Stop this worktree's dev-server, or every dev-server with --all.",
    "  dev list          List active dev-servers across all worktrees.",
    "  dev status        Report whether this worktree's dev-server is UP or DOWN.",
    "  dev setup [--force] [--reset-ports] [--verbose]",
    "                    Allocate this workspace's ports, write its run files, and provision its",
    "                    infrastructure once. Also runs before every start.",
    "  dev --help        Show this help message (alias: -h).",
    "",
    "Options (dev, dev up, dev restart):",
    "  --evict     Evict the oldest dev-server when the cap is reached.",
    "Options (dev, dev up):",
    "  --restart   If a dev-server is already running here, stop it first, then start.",
    "Options (dev setup):",
    "  --force        Provision the infrastructure again (the setup hook must be idempotent).",
    "  --reset-ports  Allocate this workspace's ports again. Refused while its dev-server runs.",
    "  --verbose      Enable verbose project setup output.",
  ]
    .map((line) => line.replace(/^ {2}dev(?=\s)/, `  ${commands.dev.withArgs}`))
    .join("\n");
}
