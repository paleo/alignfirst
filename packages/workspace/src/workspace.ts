import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

import {
  parseWorkspaceArgs,
  printWorkspaceHelp,
  printWorkspaceVersion,
  type WorkspaceCommand,
  type WorkspaceSelector,
} from "./cli.js";
import {
  findOwnEntry,
  liveWorktrees,
  readDevServers,
  removeDevServerEntryByWorktree,
} from "./dev-servers-registry.js";
import { ConfigError, WorkspaceError } from "./errors.js";
import { printGuide } from "./guide.js";
import {
  copyAndPatchFile,
  formatDuration,
  type ResolvedFileSource,
  setupLogPath,
  setupProgressPath,
} from "./helpers.js";
import { followLogFile, LOG_TAIL_LINES, replayTail } from "./log-polling.js";
import { refuseOldRegistry, runMigrate } from "./migrate.js";
import { findOrphanNames } from "./orphans.js";
import { wsCmd } from "./package-manager.js";
import {
  firstPortOf,
  type PortsConfig,
  portsForIndex,
  type ResolvedPortsConfig,
  resolvePortsConfig,
} from "./ports.js";
import { isProcessAlive, stopProcessGroup } from "./process-control.js";
import {
  indexOfEntry,
  markWorkspaceFailed,
  markWorkspaceReady,
  readWorkspaces,
  REGISTRY_SUBDIR,
  registerWorkspace,
  registryDirFor,
  resolveCurrentWorkspace,
  staleWorkspaceMessage,
  type WorkspaceEntry,
  type WorkspacesRegistry,
  type WorkspaceStatus,
  writeWorkspaces,
} from "./workspaces.js";
import {
  createBranch,
  detectWorktree,
  getWorktreeBranch,
  isWorktreeDirty,
  removeWorktree,
  type RunCtx,
  useExistingBranch,
  type WorktreeContext,
  type WorktreeDirNameFn,
} from "./worktree.js";

/** Configuration accepted by {@link runWorkspace}. */
export interface WorkspaceConfig {
  /**
   * Absolute path to the wrapper script that calls `runWorkspace`. The package re-spawns this
   * file as a detached child for the finalize phase, so it must point at a runnable Node entrypoint
   * — typically `fileURLToPath(import.meta.url)` from your `workspace.mjs`.
   */
  workspaceScript: string;
  /**
   * Absolute path to your dev-server script (the file that calls `runDevServer`). On
   * `workspace remove`, the kernel shells out to `node <devServerScript> down` with
   * `cwd: <target worktree>`. Typically
   * `fileURLToPath(new URL('./dev-server.mjs', import.meta.url))` from your `workspace.mjs`.
   * Omit it when the project has no dev-server script.
   */
  devServerScript?: string;
  /** Port scheme. Omit for portless mode: no port allocation, `ctx.ports` is empty. */
  ports?: PortsConfig;
  /** Directories symlinked from the main worktree. */
  sharedDirs: string[];
  /**
   * Per-worktree runtime directory, relative to the worktree root (e.g. `.local-wt`).
   * Holds the setup log and dev-server logs.
   */
  runtimeDir: string;
  /** Gitignored files seeded into each worktree (from main, a committed template, or content) and patched per workspace. */
  gitignoredFiles: GitignoredFileEntry[];
  /**
   * Runs before `gitignoredFiles` are copied. Use this to bootstrap source files the kernel expects
   * to find (e.g. seed `config.json` from `config.example.json` on the main worktree, decrypt
   * an env file). MUST be idempotent. On a linked-worktree setup, MUST NOT mutate the main
   * worktree — bootstrap the main worktree first via `workspace setup`.
   */
  preSetup?: (ctx: PreSetupContext) => Promise<void> | void;
  /**
   * MUST be idempotent. After a failure, the user re-runs `workspace setup` from inside
   * the worktree — this callback will be invoked again with the same context. Re-runs must not
   * error on pre-existing state (created directories, started containers, ran migrations,
   * installed deps, etc.).
   *
   * Runs in a detached child whose stdout/stderr are already redirected to
   * `<runtimeDir>/logs/workspace-setup.log`. `console.log` and child-process `stdio: "inherit"` land there.
   *
   * May return `{ purgeData }` — an opaque blob persisted on the registry entry and handed back to
   * {@link purgeInfrastructure}, so an orphaned worktree can still be torn down after its config is gone.
   * Store only teardown identifiers you cannot re-derive at purge time (e.g. a random external resource
   * id). Deterministic names — containers, volumes — derive from `name` + paths, so they don't belong here.
   */
  finalizeWorkspace: (
    ctx: FinalizeContext,
  ) => Promise<FinalizeResult | undefined> | FinalizeResult | undefined;
  /**
   * Destructive infrastructure teardown (e.g. `docker compose down -v` to wipe volumes). Runs after
   * the dev-server stop on `workspace remove`, and on `workspace prune` / removing an orphaned
   * worktree. MUST be idempotent and tolerate already-absent infrastructure: it may run when the
   * worktree directory is gone (`ctx.purgeData` carries the recorded teardown identifiers; `ctx.worktree`
   * no longer exists), so branch on the worktree's presence and tear down by name in that case.
   * Best-effort; errors should be swallowed.
   */
  purgeInfrastructure?: (ctx: PurgeContext) => Promise<void> | void;
  /** Builds the post-setup summary printed to stdout. */
  formatSummary: (ctx: SummaryContext) => string;
  /**
   * Optional override for the worktree directory basename. Receives `{ branch, repoName }` and
   * returns the basename (e.g. `myrepo-feat-ABC-123`). Defaults to {@link defaultWorktreeDirName},
   * which strips a recognizable ticket suffix and caps the slug at 22 chars. The kernel handles
   * deduplication (`-2`, `-3`…) when the resulting directory already exists.
   */
  worktreeDirName?: WorktreeDirNameFn;
}

/** Context passed to {@link WorkspaceConfig.preSetup}. */
export interface PreSetupContext {
  currentWorktree: string;
  mainWorktree: string;
  /** `true` when running on the main worktree (i.e. `workspace setup` from the main checkout). */
  isMainWorktree: boolean;
  /** Mirrors `--force`. Hooks may use it to overwrite previously bootstrapped files. */
  force: boolean;
  /** Writes to stdout and the setup log. */
  log: (msg: string) => void;
}

/** Return value of {@link WorkspaceConfig.finalizeWorkspace}. */
export interface FinalizeResult {
  purgeData: unknown;
}

/** Context passed to {@link WorkspaceConfig.finalizeWorkspace}. */
export interface FinalizeContext {
  currentWorktree: string;
  mainWorktree: string;
  /** `true` when finalizing the main worktree. Gate "copy from main" steps with `!isMainWorktree`. */
  isMainWorktree: boolean;
  /** Workspace name: the worktree directory basename. */
  name: string;
  /** Live-resolved branch of `currentWorktree`. `"(detached)"` for detached HEAD. */
  branch: string;
  /** Empty in portless mode. */
  ports: Record<string, number>;
  force: boolean;
  verbose: boolean;
  /**
   * Reports a step label shown by the blocking `workspace setup` / `wait` progress ticker.
   * Optional to call; each call replaces the previously reported label.
   */
  progress: (label: string) => void;
}

/**
 * Context passed to {@link WorkspaceConfig.formatSummary}.
 *
 * Called after worktree creation; the dev-server is not running yet.
 */
export interface SummaryContext {
  /** Workspace name: the worktree directory basename. */
  name: string;
  /** Live-resolved branch of `currentWorktree`. `"(detached)"` for detached HEAD. */
  branch: string;
  /** Empty in portless mode. */
  ports: Record<string, number>;
  currentWorktree: string;
  mainWorktree: string;
  /** `true` when the summary describes the main worktree. */
  isMainWorktree: boolean;
  /** Finalize status. `"pending"` until `finalizeWorkspace` succeeds, then `"ready"`. */
  status: WorkspaceStatus;
}

/** Context passed to {@link WorkspaceConfig.purgeInfrastructure}. */
export interface PurgeContext {
  /** The target worktree. May no longer exist on disk when purging an orphan — check before
   * running cwd-bound commands; tear down by name (from {@link purgeData}) in that case. */
  worktree: string;
  mainWorktree: string;
  /** Workspace name: the registry key, which outlives the deleted worktree directory. */
  name: string;
  /** The blob the consumer returned from `finalizeWorkspace`, if any. */
  purgeData?: unknown;
  verbose: boolean;
}

/** One gitignored file seeded from its source and patched per workspace. */
export interface GitignoredFileEntry {
  /** Path relative to the worktree root. Written to the current worktree. */
  path: string;
  /** Where the initial content comes from. */
  source: GitignoredFileSource;
  /** Rewrites the source content per workspace. Omit to copy the content verbatim. */
  patch?: (content: string, ctx: PatchContext) => string;
  /**
   * When `true`, a missing source file logs a warning and skips the entry instead of aborting.
   * Applies to `mainWorktree` and `committed` sources; ignored for `content`.
   */
  optional?: boolean;
}

/** Where a {@link GitignoredFileEntry}'s initial content comes from. */
export type GitignoredFileSource = MainWorktreeSource | CommittedSource | ContentSource;

/** Copies the gitignored file at the entry's `path` from the main worktree. */
export interface MainWorktreeSource {
  kind: "mainWorktree";
}

/** Copies a committed template from the worktree's own checkout, so it tracks the branch. */
export interface CommittedSource {
  kind: "committed";
  /** Path of the template, relative to the worktree root (e.g. a committed `.example` file). */
  path: string;
}

/** Uses the given content verbatim. The function form may be async. */
export interface ContentSource {
  kind: "content";
  content: string | (() => string | Promise<string>);
}

/** Context passed to {@link GitignoredFileEntry.patch}. */
export interface PatchContext {
  /** Workspace name: the worktree directory basename. */
  name: string;
  /** Empty in portless mode. */
  ports: Record<string, number>;
  mainWorktree: string;
  currentWorktree: string;
}

/** Per-invocation state shared by every command flow. */
interface Kernel {
  config: WorkspaceConfig;
  /** The registry directory, relative to a worktree root. */
  registryDir: string;
  /** Resolved port scheme. `undefined` in portless mode. */
  ports?: ResolvedPortsConfig;
}

export async function runWorkspace(config: WorkspaceConfig): Promise<void> {
  let command: WorkspaceCommand;
  let verbose: boolean;
  try {
    ({ command, verbose } = parseWorkspaceArgs());
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Warning: ${err.message}`);
      printWorkspaceHelp();
      process.exit(1);
    }
    throw err;
  }

  if (command.kind === "help") {
    printWorkspaceHelp();
    return;
  }

  if (command.kind === "version") {
    printWorkspaceVersion();
    return;
  }

  if (command.kind === "guide") {
    printGuide({
      runtimeDir: config.runtimeDir,
      sharedDirs: config.sharedDirs,
      hasDevServer: config.devServerScript !== undefined,
      hasPorts: config.ports !== undefined,
    });
    return;
  }

  const kernel: Kernel = {
    config,
    registryDir: registryDirFor(config.runtimeDir),
    ports: resolveConfigPorts(config),
  };

  if (!existsSync(config.workspaceScript)) {
    console.error(
      `Error: workspaceScript does not exist: ${config.workspaceScript}. ` +
        "Pass `fileURLToPath(import.meta.url)` from your wrapper script.",
    );
    process.exit(1);
  }

  try {
    const ctx = detectWorktree();

    if (command.kind === "migrate") {
      runMigrate(ctx, {
        registryDir: kernel.registryDir,
        ports: kernel.ports,
        hasPurgeInfrastructure: config.purgeInfrastructure !== undefined,
      });
      return;
    }
    refuseOldRegistry(ctx.mainWorktree, kernel.registryDir);

    switch (command.kind) {
      case "finalize":
        await runFinalize(command, kernel);
        return;
      case "wait":
        await runWait(command, kernel, verbose);
        return;
      case "status":
        runStatus(command, kernel);
        return;
      case "list":
        runList(kernel);
        return;
      case "prune":
        await runPrune(kernel, verbose);
        return;
    }

    const run: RunCtx = { verbose };

    switch (command.kind) {
      case "remove":
        await handleRemove(command, ctx, run, kernel);
        return;
      case "setup": {
        const { name, worktree } = await runSetup(command, ctx, run, kernel);
        // Default: block until the detached finalize settles (READY/FAILED), showing progress.
        // `--detached` skips the wait and returns as soon as the worktree exists — the caller joins
        // later with `wait`.
        if (!command.detached) {
          await waitForWorkspace(name, kernel, { formatSummary: false, verbose });
        }
        // The worktree exists once `runSetup` returns, so `--enter` can enter in either mode.
        if (command.enter) enterWorktree(worktree);
        return;
      }
    }
  } catch (err) {
    if (err instanceof WorkspaceError) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

/** Validates the `ports` group eagerly, on every command, so a broken config fails fast. */
function resolveConfigPorts(config: WorkspaceConfig): ResolvedPortsConfig | undefined {
  if (config.ports === undefined) return;
  try {
    return resolvePortsConfig(config.ports);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

/**
 * `--enter`: open an interactive shell in the freshly set-up worktree (exit to return). Falls back to
 * printing a `cd` hint when there is no `$SHELL` or stdin is not a tty (scripts, pipes) — dropping
 * into an interactive shell there would hang.
 */
function enterWorktree(worktree: string): void {
  const shell = process.env.SHELL;
  if (shell === undefined || !process.stdin.isTTY) {
    printCdHint(worktree);
    return;
  }
  console.log(`Entering ${worktree} (exit to return).`);
  const result = spawnSync(shell, [], { cwd: worktree, stdio: "inherit" });
  if (result.error) {
    console.error(`Could not start ${shell}: ${result.error.message}`);
    printCdHint(worktree);
  }
}

function printCdHint(worktree: string): void {
  console.log(`Now run: cd '${worktree}'`);
}

type SetupCommand = Extract<WorkspaceCommand, { kind: "setup" }>;

async function runSetup(
  command: SetupCommand,
  ctx: WorktreeContext,
  run: RunCtx,
  kernel: Kernel,
): Promise<{ name: string; worktree: string }> {
  const { config, registryDir } = kernel;
  const setupCtx = ensureWorktree(command, ctx, run, config.worktreeDirName);
  refuseIfFinalizePending(setupCtx, registryDir, command.force);
  const branch = getWorktreeBranch(setupCtx.currentWorktree) ?? "(detached)";
  const { name, status, portIndex } = registerWorkspace({
    currentWorktree: setupCtx.currentWorktree,
    mainWorktree: setupCtx.mainWorktree,
    registryDir,
    isMainWorktree: setupCtx.isMainWorktree,
    ports: kernel.ports,
    force: command.force,
  });
  const ports = kernel.ports ? portsForIndex(kernel.ports, portIndex ?? 0) : {};

  const logPath = setupLogPath(setupCtx.currentWorktree, config.runtimeDir);
  mkdirSync(dirname(logPath), { recursive: true });
  // Truncate any prior log so `workspace setup` retries start with a clean record (the previous run's
  // FAILED: banner would otherwise linger and produce false positives for grep-based tooling).
  writeFileSync(logPath, "");
  rmSync(setupProgressPath(setupCtx.currentWorktree, config.runtimeDir), { force: true });
  // Opened "a" so the same fd can be inherited by the detached finalize child below.
  const logFd = openSync(logPath, "a");
  const teeLog = (message: string): void => {
    console.log(message);
    appendFileSync(logFd, `${message}\n`);
  };
  const verboseLog = (msg: string): void => {
    if (run.verbose) teeLog(msg);
    else appendFileSync(logFd, `${msg}\n`);
  };

  if (kernel.ports) {
    verboseLog(
      `Using ports (${Object.entries(ports)
        .map(([portName, port]) => `${portName}: ${port}`)
        .join(", ")})`,
    );
  }

  if (config.preSetup) {
    await config.preSetup({
      currentWorktree: setupCtx.currentWorktree,
      mainWorktree: setupCtx.mainWorktree,
      isMainWorktree: setupCtx.isMainWorktree,
      force: command.force,
      log: teeLog,
    });
  }

  linkSharedDirectories(setupCtx, config.sharedDirs, verboseLog);
  linkWorkspaceRegistry(setupCtx, config.runtimeDir, verboseLog);
  await seedGitignoredFiles(
    setupCtx,
    config.gitignoredFiles,
    name,
    ports,
    command.force,
    verboseLog,
  );

  teeLog(
    config.formatSummary({
      name,
      branch,
      ports,
      currentWorktree: setupCtx.currentWorktree,
      mainWorktree: setupCtx.mainWorktree,
      isMainWorktree: setupCtx.isMainWorktree,
      status,
    }),
  );

  teeLog(`WORKSPACE_CREATED path=${setupCtx.currentWorktree} branch=${branch}`);
  if (command.detached && status !== "ready") {
    teeLog(`Setup continuing in background. Tail: ${logPath}`);
    teeLog(`Join it with \`${wsCmd("wait")}\`.`);
  }

  const finalizeArgs = [config.workspaceScript, "__finalize"];
  if (command.force) finalizeArgs.push("--force");
  const child = spawn(process.execPath, finalizeArgs, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    cwd: setupCtx.currentWorktree,
  });
  child.unref();
  closeSync(logFd);
  return { name, worktree: setupCtx.currentWorktree };
}

/**
 * The `wait` command to suggest for a worktree: no argument when it is the current worktree (the
 * common case), otherwise selected by its directory name.
 */
function waitCommand(worktree: string, currentWorktree: string): string {
  if (resolve(worktree) === resolve(currentWorktree)) return wsCmd("wait");
  return wsCmd(`wait ${basename(worktree)}`);
}

function refuseIfFinalizePending(ctx: WorktreeContext, registryDir: string, force: boolean): void {
  if (force) return;
  const name = basename(ctx.currentWorktree);
  const entry = readWorkspaces(ctx.mainWorktree, registryDir).workspaces[name];
  if (entry?.status !== "pending") return;
  if (resolve(entry.worktree) !== resolve(ctx.currentWorktree)) return;
  console.error(
    `Error: Setup is already in progress for workspace ${name}. ` +
      `Run \`${wsCmd("wait")}\` to wait for it to finish (or fail), then retry. ` +
      "Use --force to bypass.",
  );
  process.exit(1);
}

type FinalizeCommand = Extract<WorkspaceCommand, { kind: "finalize" }>;

async function runFinalize(command: FinalizeCommand, kernel: Kernel): Promise<void> {
  const { config, registryDir } = kernel;
  const ctx = detectWorktree();
  const name = basename(ctx.currentWorktree);
  const logPath = setupLogPath(ctx.currentWorktree, config.runtimeDir);
  const progressPath = setupProgressPath(ctx.currentWorktree, config.runtimeDir);
  const appendLog = (message: string): void => {
    appendFileSync(logPath, `${message}\n`);
  };
  const progress = (label: string): void => {
    writeFileSync(progressPath, label);
    appendLog(`PROGRESS: ${label}`);
  };

  const registry = readWorkspaces(ctx.mainWorktree, registryDir);
  const entry = registry.workspaces[name];
  if (!entry || resolve(entry.worktree) !== resolve(ctx.currentWorktree)) {
    appendLog(`FAILED: No workspace "${name}" registered for worktree ${ctx.currentWorktree}.`);
    process.exit(1);
  }

  const branch = getWorktreeBranch(ctx.currentWorktree) ?? "(detached)";

  if (entry.status === "ready" && !command.force) {
    appendLog(`READY: branch ${branch} (workspace ${name}) already finalized; skipping.`);
    return;
  }

  const index = kernel.ports ? indexOfEntry(entry) : undefined;
  if (kernel.ports && index === undefined) {
    appendLog(`FAILED: ${staleWorkspaceMessage(name, entry.worktree)}`);
    process.exit(1);
  }
  const ports = kernel.ports && index !== undefined ? portsForIndex(kernel.ports, index) : {};

  appendLog(`--- finalizing workspace ${name} at ${new Date().toISOString()} ---`);

  const setupContext: FinalizeContext = {
    currentWorktree: ctx.currentWorktree,
    mainWorktree: ctx.mainWorktree,
    isMainWorktree: ctx.isMainWorktree,
    name,
    branch,
    ports,
    force: command.force,
    verbose: false,
    progress,
  };

  try {
    const result = await config.finalizeWorkspace(setupContext);
    markWorkspaceReady(ctx.mainWorktree, registryDir, name, result?.purgeData);
    rmSync(progressPath, { force: true });
    appendLog("============================================================");
    appendLog(`READY: branch ${branch} (workspace ${name})`);
    appendLog("============================================================");
  } catch (err) {
    const message = (err as Error).message;
    const stack = (err as Error).stack ?? "";
    markWorkspaceFailed(ctx.mainWorktree, registryDir, name, message);
    rmSync(progressPath, { force: true });
    appendLog(`FAILED: ${message}`);
    if (stack) appendLog(stack);
    process.exit(1);
  }
}

/** The single workspace a `status`/`wait`/`remove` selector points at. */
interface ResolvedTarget {
  name: string;
  worktree: string;
  main: boolean;
}

function resolveTarget(
  selector: WorkspaceSelector,
  ctx: WorktreeContext,
  registryDir: string,
): ResolvedTarget {
  const { dir } = selector;
  if (dir !== undefined) {
    return targetFromDir(dir, readWorkspaces(ctx.mainWorktree, registryDir));
  }
  const resolved = resolveCurrentWorkspace(registryDir);
  return { name: resolved.name, worktree: resolved.worktree, main: resolved.main ?? false };
}

function targetFromDir(dir: string, registry: WorkspacesRegistry): ResolvedTarget {
  const name = matchWorktreeByDir(dir, registry, process.cwd());
  if (name === undefined) {
    console.error(
      `Error: No workspace matching "${dir}" (by path or directory name). Run \`${wsCmd("list")}\`.`,
    );
    process.exit(1);
  }
  const entry = registry.workspaces[name];
  return { name, worktree: entry.worktree, main: entry.main ?? false };
}

/**
 * Matches `dir` against the registry: first as a path (resolved against `cwd`), then as a workspace
 * name — the registry key, which still resolves an orphan whose directory is gone.
 */
export function matchWorktreeByDir(
  dir: string,
  registry: WorkspacesRegistry,
  cwd: string,
): string | undefined {
  const resolvedPath = resolve(cwd, dir);
  for (const [name, entry] of Object.entries(registry.workspaces)) {
    if (resolve(entry.worktree) === resolvedPath) return name;
  }
  return registry.workspaces[dir] ? dir : undefined;
}

function printWorktreeInfo(kernel: Kernel, target: ResolvedTarget, worktreeForLog: string): void {
  const { config, registryDir } = kernel;
  const ctx = detectWorktree();
  const entry: WorkspaceEntry | undefined = readWorkspaces(ctx.mainWorktree, registryDir)
    .workspaces[target.name];
  const ports = portsForEntry(kernel, entry, target);

  const status: WorkspaceStatus = entry?.status ?? "pending";
  const setupLog = setupLogPath(worktreeForLog, config.runtimeDir);
  const now = Date.now();
  const isMainWorktree = entry?.main ?? target.main;
  const targetWorktree = entry?.worktree ?? ctx.currentWorktree;
  const branch = getWorktreeBranch(targetWorktree) ?? "(detached)";
  console.log(
    config.formatSummary({
      name: target.name,
      branch,
      ports,
      currentWorktree: targetWorktree,
      mainWorktree: ctx.mainWorktree,
      isMainWorktree,
      status,
    }),
  );
  if (status === "failed") {
    const at = entry?.failure?.at ?? entry?.createdAt;
    const elapsed = at ? formatDuration(now - Date.parse(at)) : "?";
    const reason = entry?.failure?.message ?? "(no message)";
    console.log(`Failure: ${reason} (${elapsed} ago, tail ${setupLog})`);
  } else if (status === "pending" && entry) {
    const elapsed = formatDuration(now - Date.parse(entry.createdAt));
    console.log(`Pending since ${elapsed} ago (tail ${setupLog})`);
  }
  if (config.devServerScript !== undefined) {
    printDevServerBlock(config, registryDir, ctx.mainWorktree, targetWorktree, now);
  }
}

/**
 * The workspace's ports, empty in portless mode. A missing entry is the synthesized main worktree
 * (index 0); a registered entry without a port index predates the `ports` config, and is fatal.
 */
function portsForEntry(
  kernel: Kernel,
  entry: WorkspaceEntry | undefined,
  target: ResolvedTarget,
): Record<string, number> {
  if (kernel.ports === undefined) return {};
  const index = entry === undefined ? 0 : indexOfEntry(entry);
  if (index === undefined) {
    console.error(`Error: ${staleWorkspaceMessage(target.name, target.worktree)}`);
    process.exit(1);
  }
  return portsForIndex(kernel.ports, index);
}

function printDevServerBlock(
  config: WorkspaceConfig,
  registryDir: string,
  mainWorktree: string,
  targetWorktree: string,
  now: number,
): void {
  const entry = findOwnEntry(mainWorktree, registryDir, targetWorktree);
  const liveEntries = entry
    ? Object.entries(entry.pids)
        .filter(([, pid]) => isProcessAlive(pid))
        .sort(([a], [b]) => a.localeCompare(b))
    : [];
  if (liveEntries.length === 0 || !entry) {
    console.log("Dev-server: not running");
    return;
  }
  const elapsed = formatDuration(now - Date.parse(entry.startedAt));
  console.log(`Dev-server: running, started ${elapsed} ago`);
  for (const [name, pid] of liveEntries) {
    console.log(`  ${name}: PID ${pid}`);
    console.log(`    log: ${join(targetWorktree, config.runtimeDir, "logs", `${name}.log`)}`);
  }
}

type StatusCommand = Extract<WorkspaceCommand, { kind: "status" }>;

function runStatus(command: StatusCommand, kernel: Kernel): void {
  const ctx = detectWorktree();
  const target = resolveTarget(command.selector, ctx, kernel.registryDir);
  printWorktreeInfo(kernel, target, target.worktree);
}

function runList(kernel: Kernel): void {
  const { registryDir } = kernel;
  const ctx = detectWorktree();
  const liveOrphans = autoPruneSafeOrphans(ctx.mainWorktree, registryDir);
  const entries = sortedEntries(readWorkspaces(ctx.mainWorktree, registryDir));
  if (entries.length === 0) {
    console.log("No workspaces registered.");
    hintLiveOrphans(liveOrphans);
    return;
  }
  const liveSet = liveWorktrees(readDevServers(ctx.mainWorktree, registryDir));
  const resolvedPorts = kernel.ports;
  const headers = ["NAME", "TYPE", "STATUS", "DEV"];
  if (resolvedPorts) headers.push("PORTS");
  headers.push("BRANCH", "PATH", "CREATED");
  const rows = entries.map(([name, entry]) => {
    const cells = [
      name,
      entry.main ? "main" : "linked",
      entry.status,
      liveSet.has(resolve(entry.worktree)) ? "up" : "-",
    ];
    if (resolvedPorts) cells.push(firstPortCell(resolvedPorts, entry));
    cells.push(getWorktreeBranch(entry.worktree) ?? "(detached)", entry.worktree, entry.createdAt);
    return cells;
  });
  for (const line of renderTable(headers, rows)) console.log(line);
  hintLiveOrphans(liveOrphans);
}

/** Main worktree first, then by workspace name. */
function sortedEntries(registry: WorkspacesRegistry): [string, WorkspaceEntry][] {
  return Object.entries(registry.workspaces).sort(([nameA, a], [nameB, b]) => {
    if (a.main !== b.main) return a.main ? -1 : 1;
    return nameA.localeCompare(nameB);
  });
}

/** The first port of the entry's block, or `?` when the entry predates the `ports` config. */
function firstPortCell(resolvedPorts: ResolvedPortsConfig, entry: WorkspaceEntry): string {
  const index = indexOfEntry(entry);
  return index === undefined ? "?" : String(firstPortOf(resolvedPorts, index));
}

function renderTable(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => row[i].length)),
  );
  return [headers, ...rows].map((cells) =>
    cells.map((cell, i) => (i === cells.length - 1 ? cell : cell.padEnd(widths[i]))).join("  "),
  );
}

/**
 * Silently drop registry entries for worktrees deleted out-of-band that have no live dev-server —
 * harmless bookkeeping, consistent with the existing dead-PID pruning. Orphans whose dev-server is
 * still running are left untouched (stopping a live process is the explicit `workspace prune`'s job)
 * and returned so the caller can hint about them.
 */
function autoPruneSafeOrphans(mainWorktree: string, registryDir: string): string[] {
  const registry = readWorkspaces(mainWorktree, registryDir);
  const orphanNames = findOrphanNames(registry);
  if (orphanNames.length === 0) return [];
  const live = liveWorktrees(readDevServers(mainWorktree, registryDir));
  const liveOrphans: string[] = [];
  let changed = false;
  for (const name of orphanNames) {
    const entry = registry.workspaces[name];
    if (live.has(resolve(entry.worktree))) {
      liveOrphans.push(name);
      continue;
    }
    delete registry.workspaces[name];
    removeDevServerEntryByWorktree(mainWorktree, registryDir, entry.worktree);
    changed = true;
  }
  if (changed) writeWorkspaces(mainWorktree, registryDir, registry);
  return liveOrphans;
}

function hintLiveOrphans(liveOrphans: string[]): void {
  if (liveOrphans.length === 0) return;
  console.log(
    `\nNote: ${liveOrphans.length} workspace(s) have a deleted worktree but a still-running ` +
      `dev-server. Run \`${wsCmd("prune")}\` to stop them and clean up.`,
  );
}

async function runPrune(kernel: Kernel, verbose: boolean): Promise<void> {
  const { config, registryDir } = kernel;
  const ctx = detectWorktree();
  const registry = readWorkspaces(ctx.mainWorktree, registryDir);
  const orphanNames = findOrphanNames(registry);

  let stoppedProcesses = 0;
  for (const name of orphanNames) {
    const entry = registry.workspaces[name];
    stoppedProcesses += await stopOrphanedDevServer(ctx.mainWorktree, registryDir, entry.worktree);
    await runPurgeInfrastructure(config, {
      worktree: entry.worktree,
      mainWorktree: ctx.mainWorktree,
      name,
      purgeData: entry.purgeData,
      verbose,
    });
    delete registry.workspaces[name];
    console.log(`Pruned workspace ${name} (${entry.worktree}).`);
  }

  if (orphanNames.length > 0) writeWorkspaces(ctx.mainWorktree, registryDir, registry);
  pruneGitWorktrees(ctx.mainWorktree);

  if (orphanNames.length === 0) {
    console.log("No orphaned workspaces to prune.");
    return;
  }
  console.log(`Pruned ${orphanNames.length} orphaned workspace(s).`);
  if (stoppedProcesses > 0) console.log(`Stopped ${stoppedProcesses} orphaned process(es).`);
  if (config.purgeInfrastructure === undefined) {
    console.log(
      "Note: infrastructure managed by callback servers (e.g. `docker compose`) is not torn down " +
        "automatically — check for leftover containers.",
    );
  }
}

/**
 * Stop a gone worktree's dev-server the only way left: its dir (and `dev-server.mjs`) is deleted, so
 * we can't shell out to `dev down` to run callback stop() — we kill the recorded spawn PIDs directly
 * and drop the dev-server entry. Returns the count of live PIDs stopped. The caller separately runs
 * `purgeInfrastructure` (by name, from the entry's `purgeData`) to tear down callback-managed infra.
 */
async function stopOrphanedDevServer(
  mainWorktree: string,
  registryDir: string,
  worktree: string,
): Promise<number> {
  const devEntry = findOwnEntry(mainWorktree, registryDir, worktree);
  if (!devEntry) return 0;
  let stopped = 0;
  for (const pid of Object.values(devEntry.pids)) {
    if (isProcessAlive(pid)) {
      await stopProcessGroup(pid);
      ++stopped;
    }
  }
  removeDevServerEntryByWorktree(mainWorktree, registryDir, worktree);
  return stopped;
}

/** Best-effort: clear git's stale `.git/worktrees/<name>` admin files for deleted worktrees. */
function pruneGitWorktrees(mainWorktree: string): void {
  try {
    execFileSync("git", ["worktree", "prune"], { cwd: mainWorktree, stdio: "ignore" });
  } catch {
    // Best-effort; nothing actionable if git is unavailable.
  }
}

type WaitCommand = Extract<WorkspaceCommand, { kind: "wait" }>;

async function runWait(command: WaitCommand, kernel: Kernel, verbose: boolean): Promise<void> {
  // standalone `workspace wait` (no prior setup in this invocation) → print the full summary on success.
  const ctx = detectWorktree();
  const target = resolveTarget(command.selector, ctx, kernel.registryDir);
  await waitForWorkspace(target.name, kernel, { verbose, replayLog: true });
}

async function waitForWorkspace(
  name: string,
  kernel: Kernel,
  options: { formatSummary?: boolean; verbose?: boolean; replayLog?: boolean } = {},
): Promise<void> {
  const { config, registryDir } = kernel;
  const formatSummary = options.formatSummary ?? true;
  const ctx = detectWorktree();
  const initial = readWorkspaces(ctx.mainWorktree, registryDir).workspaces[name];
  if (!initial) {
    console.error(`Error: No workspace "${name}" in registry.`);
    process.exit(1);
  }

  const logPath = setupLogPath(initial.worktree, config.runtimeDir);
  const progressPath = setupProgressPath(initial.worktree, config.runtimeDir);
  const ticker = startSetupTicker(
    options.verbose ?? false,
    options.replayLog ?? false,
    logPath,
    progressPath,
  );

  const pollMs = 500;
  // Poll workspaces.json — the finalize child writes `status` on success or failure. Tiny file, no
  // log-tailing race.
  for (;;) {
    const entry = readWorkspaces(ctx.mainWorktree, registryDir).workspaces[name];
    if (!entry) {
      ticker.stop();
      console.error(`Error: Workspace "${name}" disappeared from registry.`);
      process.exit(1);
    }
    if (entry.status === "ready") {
      ticker.stop();
      console.log("… ready");
      if (formatSummary) {
        const target: ResolvedTarget = {
          name,
          worktree: entry.worktree,
          main: entry.main ?? false,
        };
        printWorktreeInfo(kernel, target, entry.worktree);
      }
      return;
    }
    if (entry.status === "failed") {
      ticker.stop();
      console.error(`FAILED: ${entry.failure?.message ?? "(no message)"}`);
      console.error(`Full log: ${setupLogPath(entry.worktree, config.runtimeDir)}`);
      process.exit(1);
    }
    ticker.tick();
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

interface SetupTicker {
  /** Refresh the display; called once per poll. */
  tick: () => void;
  /** Clear the display before the settle output is printed. */
  stop: () => void;
}

/**
 * Progress feedback while a detached finalize runs. `--verbose` follows the setup log live —
 * from its current size during a blocking setup (the pre-finalize content was already printed by
 * `teeLog`), or after replaying a tail when `replayLog` is set (a standalone `wait` joins with no
 * history). Otherwise a single status line reports the latest `progress()` label and elapsed time.
 */
function startSetupTicker(
  verbose: boolean,
  replayLog: boolean,
  logPath: string,
  progressPath: string,
): SetupTicker {
  if (verbose) {
    const offset = replayLog
      ? replayTail(logPath, "", LOG_TAIL_LINES)
      : existsSync(logPath)
        ? statSync(logPath).size
        : 0;
    const follower = followLogFile(logPath, "", offset);
    return { tick: () => {}, stop: follower.stop };
  }
  return startStatusLineTicker(logPath, progressPath);
}

function startStatusLineTicker(logPath: string, progressPath: string): SetupTicker {
  const isTty = process.stdout.isTTY ?? false;
  const startedAt = Date.now();
  let lastLabel: string | undefined;
  let printed = false;
  const render = (): void => {
    const label = readProgressLabel(progressPath);
    const labelPart = label !== undefined ? ` ${label}` : "";
    const line = `Finalizing…${labelPart} (${formatDuration(Date.now() - startedAt)}) — tail: ${logPath}`;
    if (isTty) {
      process.stdout.write(`\r\x1b[2K${line}`);
      printed = true;
    } else if (!printed || label !== lastLabel) {
      console.log(line);
      printed = true;
    }
    lastLabel = label;
  };
  return {
    tick: render,
    stop: () => {
      if (isTty && printed) process.stdout.write("\r\x1b[2K");
    },
  };
}

function readProgressLabel(progressPath: string): string | undefined {
  try {
    const label = readFileSync(progressPath, "utf-8").trim();
    return label.length > 0 ? label : undefined;
  } catch {
    return undefined;
  }
}

type RemoveCommand = Extract<WorkspaceCommand, { kind: "remove" }>;

async function handleRemove(
  command: RemoveCommand,
  ctx: WorktreeContext,
  run: RunCtx,
  kernel: Kernel,
): Promise<void> {
  const { config, registryDir } = kernel;
  const verboseLog = makeVerboseLog(run.verbose);
  const registry = readWorkspaces(ctx.mainWorktree, registryDir);
  const target = resolveTarget(command.selector, ctx, registryDir);
  const name = target.name;
  const worktree = target.worktree;
  if (resolve(worktree) === resolve(ctx.mainWorktree)) {
    console.error("Error: Cannot remove the main worktree.");
    process.exit(1);
  }
  const removeHere = resolve(worktree) === resolve(ctx.currentWorktree);
  const branch = getWorktreeBranch(worktree) ?? "(detached)";

  // Refuse to remove while the detached finalize is still writing to workspaces.json /
  // workspace-setup.log: racing the two corrupts the registry and leaves the worktree orphaned.
  if (registry.workspaces[name]?.status === "pending") {
    console.error(
      `Error: Setup is still in progress for workspace ${name}. ` +
        `Run \`${waitCommand(worktree, ctx.currentWorktree)}\` to wait for it to finish (or fail), then retry the removal.`,
    );
    process.exit(1);
  }

  if (!existsSync(worktree)) {
    console.warn(`Warning: Worktree directory ${worktree} not found. Cleaning up registry only.`);
    await stopOrphanedDevServer(ctx.mainWorktree, registryDir, worktree);
    await runPurgeInfrastructure(config, {
      worktree,
      mainWorktree: ctx.mainWorktree,
      name,
      purgeData: registry.workspaces[name]?.purgeData,
      verbose: run.verbose,
    });
    delete registry.workspaces[name];
    writeWorkspaces(ctx.mainWorktree, registryDir, registry);
    pruneGitWorktrees(ctx.mainWorktree);
    console.log(`Removed registry entry for workspace ${name} (branch "${branch}").`);
    return;
  }

  if (!command.force && isWorktreeDirty(worktree)) {
    console.error(
      `Error: Uncommitted changes in ${worktree}. Commit or stash them, or pass --force.`,
    );
    process.exit(1);
  }

  const { devServerScript } = config;
  if (devServerScript === undefined) {
    verboseLog("No dev-server script configured; skipping stop.");
  } else if (findOwnEntry(ctx.mainWorktree, registryDir, worktree)) {
    stopTargetDevServer(devServerScript, worktree, verboseLog);
  } else {
    verboseLog(`No dev-server running in ${worktree}; skipping stop.`);
  }

  await runPurgeInfrastructure(config, {
    worktree,
    mainWorktree: ctx.mainWorktree,
    name,
    purgeData: registry.workspaces[name]?.purgeData,
    verbose: run.verbose,
  });

  delete registry.workspaces[name];
  writeWorkspaces(ctx.mainWorktree, registryDir, registry);
  removeDevServerEntryByWorktree(ctx.mainWorktree, registryDir, worktree);

  if (removeHere) process.chdir(ctx.mainWorktree);

  removeWorktree(worktree, run);

  console.log(`Removed workspace ${name} (branch "${branch}"). Branch "${branch}" kept.`);
  if (removeHere) console.log(`Now run: cd ${ctx.mainWorktree}`);
}

async function runPurgeInfrastructure(config: WorkspaceConfig, ctx: PurgeContext): Promise<void> {
  if (config.purgeInfrastructure) await config.purgeInfrastructure(ctx);
}

function ensureWorktree(
  command: SetupCommand,
  ctx: WorktreeContext,
  run: RunCtx,
  dirNameFn: WorktreeDirNameFn | undefined,
): WorktreeContext {
  if (command.branch === undefined) return ctx;
  if (command.newBranch) {
    return createBranch(command.branch, ctx, run, {
      dirNameFn,
      from: command.from,
      dedupe: command.dedupe,
    });
  }
  return useExistingBranch(command.branch, ctx, run, dirNameFn);
}

export function linkSharedDirectories(
  ctx: WorktreeContext,
  dirs: string[],
  log: (msg: string) => void,
): void {
  for (const dirName of dirs) {
    const mainDir = join(ctx.mainWorktree, dirName);
    if (!existsSync(mainDir)) {
      // A dead symlink (e.g. `.plans` pointing at a moved clone of the plans repository) must be repaired by the
      // user, not shadowed by a fresh directory.
      if (lstatSync(mainDir, { throwIfNoEntry: false })?.isSymbolicLink()) {
        throw new WorkspaceError(
          `'${dirName}' in the main worktree is a broken symlink. Repair it, then retry.`,
        );
      }
      mkdirSync(mainDir, { recursive: true });
      log(`Created ${dirName} in the main worktree (shared directory was missing).`);
    }
    if (ctx.isMainWorktree) continue;
    const link = join(ctx.currentWorktree, dirName);
    if (existsSync(link)) {
      log(`Skipped ${dirName} symlink (already exists).`);
    } else {
      const relTarget = relative(ctx.currentWorktree, mainDir);
      symlinkSync(relTarget, link);
      log(`Created ${dirName} symlink → main worktree.`);
    }
  }
}

/**
 * Symlinks the linked worktree's `${runtimeDir}/workspace-registry` to the main worktree's, so the
 * cwd-relative registry read in `resolveCurrentWorkspace` reaches main. `runtimeDir` is per-worktree
 * and not in `sharedDirs`, so this is distinct from {@link linkSharedDirectories}.
 */
function linkWorkspaceRegistry(
  ctx: WorktreeContext,
  runtimeDir: string,
  log: (msg: string) => void,
): void {
  if (ctx.isMainWorktree) return;
  const mainDir = join(ctx.mainWorktree, runtimeDir, REGISTRY_SUBDIR);
  mkdirSync(mainDir, { recursive: true });
  const runtimeRoot = join(ctx.currentWorktree, runtimeDir);
  mkdirSync(runtimeRoot, { recursive: true });
  const link = join(runtimeRoot, REGISTRY_SUBDIR);
  // lstat, not existsSync: existsSync follows symlinks, so a broken one would read as absent and
  // make symlinkSync throw EEXIST. A broken symlink is recreated even without `force`.
  const linkStat = lstatSync(link, { throwIfNoEntry: false });
  if (linkStat) {
    if (!linkStat.isSymbolicLink()) {
      log("Skipped workspace-registry symlink (a real directory exists here).");
      return;
    }
    if (existsSync(link)) {
      log("Skipped workspace-registry symlink (already exists).");
      return;
    }
    rmSync(link);
  }
  symlinkSync(relative(runtimeRoot, mainDir), link);
  log("Created workspace-registry symlink → main worktree.");
}

async function seedGitignoredFiles(
  ctx: WorktreeContext,
  entries: GitignoredFileEntry[],
  name: string,
  ports: Record<string, number>,
  force: boolean,
  log: (msg: string) => void,
): Promise<void> {
  for (const entry of entries) {
    const patchCtx: PatchContext = {
      name,
      ports,
      mainWorktree: ctx.mainWorktree,
      currentWorktree: ctx.currentWorktree,
    };
    const { patch } = entry;
    const patchFn = patch
      ? (content: string) => patch(content, patchCtx)
      : (content: string) => content;
    copyAndPatchFile(
      { currentWorktree: ctx.currentWorktree, log },
      entry.path,
      await resolveFileSource(entry, patchCtx),
      patchFn,
      entry.path,
      force,
      entry.optional ?? false,
    );
  }
}

export async function resolveFileSource(
  entry: GitignoredFileEntry,
  ctx: PatchContext,
): Promise<ResolvedFileSource> {
  const { source } = entry;
  switch (source.kind) {
    case "mainWorktree":
      return { path: join(ctx.mainWorktree, entry.path) };
    case "committed":
      return { path: join(ctx.currentWorktree, source.path) };
    case "content":
      return {
        content: typeof source.content === "function" ? await source.content() : source.content,
      };
  }
}

/**
 * Stops the dev-server running in the target worktree by shelling out to
 * `node <devServerScript> down` with `cwd: worktreePath`. The subprocess runs the target's
 * own stop flow — registry-based spawn-PID kill + callback `stop()` from the target's branch.
 */
function stopTargetDevServer(
  devServerScript: string,
  worktreePath: string,
  log: (msg: string) => void,
): void {
  log(`Stopping dev-server in ${worktreePath}...`);
  const result = spawnSync(process.execPath, [devServerScript, "down"], {
    cwd: worktreePath,
    stdio: "inherit",
    timeout: 30_000,
  });
  if (result.error) {
    console.warn(`Warning: failed to run dev down: ${result.error.message}`);
  } else if (result.status !== 0) {
    console.warn(`Warning: dev down exited with code ${result.status}.`);
  }
}

function makeVerboseLog(verbose: boolean): (msg: string) => void {
  return (msg) => {
    if (verbose) console.log(msg);
  };
}
