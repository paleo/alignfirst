import { parseArgs } from "node:util";

import type { CommandForms } from "../command-form.js";
import type { Output } from "../output.js";
import { type AddOptions, addWorktree } from "./add.js";
import { type GitContext, readRepository, type Worktree } from "./git.js";
import { removeWorktree } from "./remove.js";
import { setupWorktree, type WorktreeReport } from "./setup.js";

export interface WorktreeContext extends GitContext {
  stdout: Output;
  stderr: Output;
  forms: CommandForms;
  alignfirstCommand: string[];
}

type WorktreeCommand =
  | { kind: "help" }
  | { kind: "list"; json: boolean }
  | { kind: "setup"; path?: string; json: boolean }
  | { kind: "remove"; path: string; json: boolean }
  | { kind: "add"; options: AddOptions; json: boolean };

export function runWorktree(tokens: string[], ctx: WorktreeContext): number {
  const command = parseWorktreeArgs(tokens, ctx.forms.aligndev);
  if (command.kind === "help") {
    ctx.stdout.write(renderHelp(ctx.forms.aligndev));
    return 0;
  }
  const repo = readRepository(ctx);
  if (command.kind === "list") {
    const report = { mainWorktree: repo.mainWorktree, worktrees: repo.worktrees };
    ctx.stdout.write(command.json ? json(report) : renderList(repo.worktrees));
    return 0;
  }
  if (command.kind === "remove") {
    const report = removeWorktree(ctx, repo, command.path);
    ctx.stdout.write(command.json ? json(report) : `Removed ${report.path}; branch preserved.\n`);
    return 0;
  }
  const report =
    command.kind === "setup"
      ? setupWorktree(ctx, repo, command.path)
      : addWorktree(ctx, repo, command.options);
  for (const warning of report.warnings) ctx.stderr.write(`Warning: ${warning}\n`);
  ctx.stdout.write(command.json ? json(report) : renderReady(report));
  return 0;
}

function parseWorktreeArgs(tokens: string[], aligndev: string): WorktreeCommand {
  const [command, ...rest] = tokens;
  if (command === undefined || command === "--help" || command === "-h") {
    if (tokens.length > 1) throw new Error("Unexpected worktree help arguments.");
    return { kind: "help" };
  }
  if (command !== "add" && command !== "setup" && command !== "list" && command !== "remove") {
    throw new Error(`Unknown worktree command: ${command}`);
  }
  const { values, positionals } = parseArgs({
    args: rest,
    strict: true,
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      ...(command === "add" ? { b: { type: "string" as const } } : {}),
    },
  });
  if (values.help) return { kind: "help" };
  const newBranch = typeof values.b === "string" ? values.b : undefined;
  const count = positionals.length;
  const expected = command === "list" ? 0 : command === "remove" ? 1 : 2;
  const validCount =
    command === "setup"
      ? count <= 1
      : command === "add" && newBranch !== undefined
        ? count === 1 || count === 2
        : count === expected;
  if (!validCount) {
    throw new Error(`Invalid arguments. Run \`${aligndev} worktree ${command} --help\`.`);
  }
  if (command === "list") return { kind: "list", json: values.json };
  if (command === "setup") return { kind: "setup", path: positionals[0], json: values.json };
  const path = positionals[0];
  if (path === undefined) throw new Error("A worktree path is required.");
  if (command === "remove") return { kind: "remove", path, json: values.json };
  const branch = newBranch ?? positionals[1];
  if (branch === undefined) throw new Error("A branch is required.");
  return {
    kind: "add",
    json: values.json,
    options: {
      path,
      branch,
      newBranch: newBranch !== undefined,
      start: newBranch === undefined ? undefined : positionals[1],
    },
  };
}

function json(report: object): string {
  return `${JSON.stringify(report, undefined, 2)}\n`;
}

function renderList(worktrees: Worktree[]): string {
  return worktrees
    .map(
      (tree) =>
        `${tree.path} [${tree.branch ?? "detached"}]${tree.main ? " main" : ""}${tree.exists ? "" : " missing"}${tree.locked ? " locked" : ""}${tree.prunable ? " prunable" : ""}\n`,
    )
    .join("");
}

function renderReady(report: WorktreeReport): string {
  return [
    `Worktree ready: ${report.worktree.path} [${report.worktree.branch ?? "detached"}]`,
    ...Object.entries(report.directories).map(
      ([name, directory]) =>
        `${name}: ${directory.mode} ${directory.path}${directory.target === null ? "" : ` -> ${directory.target}`}`,
    ),
    "Readiness covers Git and work files only; follow the project's install/build/test procedure.",
    "",
  ].join("\n");
}

function renderHelp(command: string): string {
  return `Usage:
  ${command} worktree add <path> <branch> [--json]
  ${command} worktree add <path> -b <branch> [<start-point>] [--json]
  ${command} worktree setup [<path>] [--json]
  ${command} worktree list [--json]
  ${command} worktree remove <path> [--json]
  ${command} worktree <command> --help

Paths resolve from the caller, including linked worktrees and subdirectories.
Existing branches are reused; an unambiguous fetched remote branch may create its tracking branch.
-b creates a new branch from <start-point>, or the invoking worktree's HEAD. No fetch or base refresh.
The destination must be new and outside all registered worktrees. Occupied branches must be reused
at their listed path. Bare and nonstandard Git layouts are unsupported.

Add and setup share usable untracked main-worktree .plans and optional .local through symlinks, with local
Git exclusions. Companion plans are used directly. Tracked .local stays branch-local with a warning.
Missing or project-tracked effective plans require separately authorized preparation:
  ${command} guide work-files-setup
Neither command registers a companion, migrates files, installs, builds or starts application processes.
Readiness covers Git and work files only; follow repository preparation and shutdown separately.
Setup without a path discovers the current Git worktree root, including from a nested directory.
An explicit path must be an exact existing registered root of this repository; main and detached
worktrees are supported. Setup preserves branches, the index, unrelated files and Git registration.
Equivalent shared links are reused. Conflicts are preserved; repair them and retry idempotent setup.
Late failures retain partial preparation and report a quoted setup retry command.
External tools may use this post-creation hook inside their worktree:
  ${command} worktree setup
There is no lightweight teardown hook; the external owner manages deletion and project shutdown.

List reads only Git's registry, including detached, missing, locked and prunable worktrees.
Remove accepts an exact linked root, refuses main/locked/dirty/protected shared targets, and uses
ordinary Git removal. It preserves branches, shared targets and companion registration; no force,
pruning, process teardown or recursive fallback. Stop project activity separately before removal.

--json prints one document on success; warnings and errors go to stderr. Failures exit 1.
`;
}
