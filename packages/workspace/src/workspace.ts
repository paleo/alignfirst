import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

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
import { ConfigError, errorMessage, WorkspaceError } from "./errors.js";
import {
  type GitignoredFileEntry,
  type PatchContext,
  type SetupContextBase,
  seedFiles,
} from "./file-entries.js";
import { printGuide } from "./guide.js";
import { formatDuration, setupLogPath, setupProgressPath } from "./helpers.js";
import { followLogFile, LOG_TAIL_LINES, replayTail } from "./log-polling.js";
import { refuseOldRegistry, runMigrate } from "./migrate.js";
import { findOrphanNames } from "./orphans.js";
import { configureCommands, devCmd, wsCmd } from "./package-manager.js";
import { formatPorts } from "./ports.js";
import { isProcessAlive, stopProcessGroup } from "./process-control.js";
import {
  findWorkspaceByPath,
  markWorkspaceFailed,
  markWorkspaceReady,
  readWorkspaces,
  REGISTRY_SUBDIR,
  registerWorkspace,
  registryDirFor,
  resolveCurrentWorkspace,
  updateWorkspaces,
  type WorkspaceEntry,
  type WorkspacesRegistry,
  type WorkspaceStatus,
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

const UPGRADE_POINTER =
  'Follow "Move Workspace Ports to the Dev-Server" in the alignfirst-upgrade reference of the ' +
  "alignfirst-setup-guide skill.";

/** Configuration accepted by {@link runWorkspace}. */
export interface WorkspaceConfig {
  signal?: AbortSignal;
  /**
   * Absolute path to the wrapper script that calls `runWorkspace`. The package re-spawns this
   * file as a detached child for the finalize phase, so it must point at a runnable Node entrypoint
   * — typically `fileURLToPath(import.meta.url)` from your `workspace.mjs`.
   */
  workspaceScript: string;
  /**
   * Absolute path to your dev-server script (the file that calls `runDevServer`). On
   * `workspace remove` or `teardown`, the kernel shells out to `node <devServerScript> down` with
   * `cwd: <target worktree>`; `setup --full` runs `node <devServerScript> setup`. Typically
   * `fileURLToPath(new URL('./dev-server.mjs', import.meta.url))` from your `workspace.mjs`.
   * Omit it when the project has no dev-server script.
   */
  devServerScript?: string;
  /** Directories symlinked from the main worktree. */
  sharedDirs: string[];
  /**
   * Per-worktree runtime directory, relative to the worktree root (e.g. `.local-wt`).
   * Holds the setup log and dev-server logs.
   */
  runtimeDir: string;
  /**
   * Gitignored files seeded from main, a committed fallback/template, or content and patched per
   * workspace: the files install, build or tests need. A file that carries ports belongs in
   * `DevServerConfig.runFiles`.
   */
  gitignoredFiles: GitignoredFileEntry[];
  /**
   * Runs before `gitignoredFiles` are copied. Use this for setup work outside file-source
   * resolution, such as validating shared resources, creating directories, or configuring hooks.
   * MUST be idempotent. On a linked-worktree setup, MUST NOT mutate the main worktree.
   */
  preSetup?: (ctx: PreSetupContext) => Promise<void> | void;
  /**
   * Installs and builds the workspace. Infrastructure (database, seed) belongs in
   * `DevServerConfig.setup`.
   *
   * MUST be idempotent. After a failure, the user re-runs `workspace setup` from inside
   * the worktree — this callback will be invoked again with the same context. Re-runs must not
   * error on pre-existing state (created directories, installed deps, etc.).
   *
   * Runs in a detached child whose stdout/stderr are already redirected to
   * `<runtimeDir>/logs/workspace-setup.log`. `console.log` and child-process `stdio: "inherit"` land there.
   */
  finalizeWorkspace: (ctx: FinalizeContext) => Promise<void> | void;
  /**
   * Destructive infrastructure teardown (e.g. `docker compose down -v` to wipe volumes). Runs after
   * the dev-server stop on `workspace remove` / `teardown`, and on `workspace prune` / removing an orphaned
   * worktree, whether or not a `dev setup` ever succeeded. Tears down by the workspace name
   * (`ctx.name`): every resource `DevServerConfig.setup` creates is named after it. MUST be
   * idempotent and tolerate already-absent or partial infrastructure: it may run when the worktree
   * directory is gone (`ctx.worktree` no longer exists), so never depend on the worktree's files.
   * A thrown error retains the workspace entry. Swallowing errors makes cleanup best-effort.
   */
  purgeInfrastructure?: (ctx: PurgeContext) => Promise<void> | void;
  /** Builds the post-setup summary printed to stdout. */
  formatSummary: (ctx: SummaryContext) => string | Promise<string>;
  /**
   * Optional override for the worktree directory basename. Receives `{ branch, repoName }` and
   * returns the basename (e.g. `myrepo-feat-ABC-123`). Defaults to {@link defaultWorktreeDirName},
   * which strips a recognizable ticket suffix and caps the slug at 22 chars. The kernel handles
   * deduplication (`-2`, `-3`…) when the resulting directory already exists.
   */
  worktreeDirName?: WorktreeDirNameFn;
}

/** Context passed to {@link WorkspaceConfig.preSetup}. */
export interface PreSetupContext extends SetupContextBase {
  /** Mirrors `--force`. Hooks may use it to overwrite previously bootstrapped files. */
  force: boolean;
  verbose: boolean;
  /** Writes to stdout and the setup log. */
  log: (msg: string) => void;
}

/**
 * Context passed to {@link WorkspaceConfig.finalizeWorkspace}. Gate "copy from main" steps with
 * `!isMainWorktree`.
 */
export interface FinalizeContext extends SetupContextBase {
  /** Live-resolved branch of `currentWorktree`. `"(detached)"` for detached HEAD. */
  branch: string;
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
export interface SummaryContext extends SetupContextBase {
  /** Live-resolved branch of `currentWorktree`. `"(detached)"` for detached HEAD. */
  branch: string;
  /** Finalize status. `"pending"` until `finalizeWorkspace` succeeds, then `"ready"`. */
  status: WorkspaceStatus;
}

/** Context passed to {@link WorkspaceConfig.purgeInfrastructure}. */
export interface PurgeContext {
  signal?: AbortSignal;
  /** The target worktree. May no longer exist on disk when purging an orphan: tear down by name. */
  worktree: string;
  mainWorktree: string;
  /** Workspace name: the registry key, which outlives the deleted worktree directory. */
  name: string;
  /**
   * Legacy: the blob an old `finalizeWorkspace` returned, still carried by entries created before
   * teardown by name. New workspaces never have one. Removed in a later version.
   */
  purgeData?: unknown;
  verbose: boolean;
}

/** Per-invocation state shared by every command flow. */
interface Kernel {
  config: WorkspaceConfig;
  /** The registry directory, relative to a worktree root. */
  registryDir: string;
}

export async function runWorkspace(config: WorkspaceConfig): Promise<void> {
  configureCommands({ workspace: config.workspaceScript, dev: config.devServerScript });
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
    });
    return;
  }

  const kernel: Kernel = { config, registryDir: registryDirFor(config.runtimeDir) };

  if (!existsSync(config.workspaceScript)) {
    console.error(
      `Error: workspaceScript does not exist: ${config.workspaceScript}. ` +
        "Pass `fileURLToPath(import.meta.url)` from your wrapper script.",
    );
    process.exit(1);
  }

  try {
    refuseOldConfig(config);
    const ctx = detectWorktree();

    if (command.kind === "migrate") {
      await runMigrate(ctx, {
        registryDir: kernel.registryDir,
        hasPurgeInfrastructure: config.purgeInfrastructure !== undefined,
      });
      return;
    }
    refuseOldRegistry(ctx.mainWorktree, kernel.registryDir);

    switch (command.kind) {
      case "finalize":
        await runFinalize(command, kernel, ctx, verbose);
        return;
      case "wait":
        await runWait(command, kernel, verbose);
        return;
      case "status":
        await runStatus(command, kernel);
        return;
      case "list":
        await runList(kernel);
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
      case "teardown":
        await handleTeardown(command, ctx, run, kernel);
        return;
      case "setup": {
        const { name, worktree, status } = await runSetup(command, ctx, run, kernel);
        // An already finalized workspace gets no finalize, so no dev step from the finalize child:
        // this process runs it, after the wait.
        const devStepHere = command.full && status === "ready";
        // Default: block until the detached finalize settles (READY/FAILED), showing progress.
        // `--detached` skips the wait and returns as soon as the worktree exists — the caller joins
        // later with `wait`.
        if (!command.detached) {
          await waitForWorkspace({ name, worktree }, kernel, {
            formatSummary: false,
            verbose,
            full: command.full && !devStepHere,
          });
        }
        if (devStepHere)
          await runDevStepHere(kernel, ctx.mainWorktree, worktree, command.force, run.verbose);
        // The worktree exists once `runSetup` returns, so `--enter` can enter in either mode.
        if (command.enter) enterWorktree(worktree);
        return;
      }
    }
  } catch (err) {
    if (err instanceof WorkspaceError || err instanceof ConfigError) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

/** `ports` and `setupProfiles` moved to the dev-server config in 0.37.0. */
function refuseOldConfig(config: WorkspaceConfig): void {
  const removed = ["ports", "setupProfiles"].filter((key) => key in config);
  if (removed.length === 0) return;
  throw new ConfigError(
    `The workspace config declares ${removed.map((key) => `\`${key}\``).join(" and ")}, ` +
      `removed in 0.37.0. ${UPGRADE_POINTER}`,
  );
}

/** `setup --full` on an already finalized workspace: the dev step runs in this process. */
async function runDevStepHere(
  kernel: Kernel,
  mainWorktree: string,
  worktree: string,
  force: boolean,
  verbose: boolean,
): Promise<void> {
  const failure = await runDevSetupChild({
    kernel,
    mainWorktree,
    worktree,
    fromFinalize: false,
    force,
    verbose,
  });
  if (failure === undefined) return;
  console.error(devSetupFailedMessage(failure));
  process.exit(1);
}

function devSetupFailedMessage(message: string): string {
  return `Workspace ready; dev setup failed: ${message.replace(/\.$/, "")}. Run \`${devCmd("setup")}\` to retry.`;
}

interface DevSetupChildInput {
  kernel: Kernel;
  mainWorktree: string;
  worktree: string;
  /** Passes `--from-finalize`, so the dev setup accepts the `pending` workspace. */
  fromFinalize: boolean;
  force: boolean;
  verbose: boolean;
}

/**
 * Runs `node <devServerScript> setup` in the worktree, with the caller's stdio. Returns the failure
 * message, or `undefined` on success. When the dev-server could not record its failure, records
 * `dev setup exited with code <n>`.
 */
async function runDevSetupChild(input: DevSetupChildInput): Promise<string | undefined> {
  const { kernel, mainWorktree, worktree } = input;
  const { devServerScript } = kernel.config;
  if (devServerScript === undefined) return;
  const startedAt = new Date().toISOString();
  const args = [devServerScript, "setup"];
  if (input.fromFinalize) args.push("--from-finalize");
  if (input.force) args.push("--force");
  if (input.verbose) args.push("--verbose");
  const result = spawnSync(process.execPath, args, { cwd: worktree, stdio: "inherit" });
  if (result.status === 0) return;
  const fallback = result.error
    ? `dev setup could not run: ${result.error.message}`
    : `dev setup exited with code ${result.status ?? result.signal}`;
  return updateWorkspaces(mainWorktree, kernel.registryDir, (registry) => {
    const entry = findWorkspaceByPath(registry, worktree)?.entry;
    if (!entry) return fallback;
    const recorded = entry.devSetupFailure;
    if (recorded !== undefined && recorded.at >= startedAt) return recorded.message;
    entry.devSetupFailure = { at: new Date().toISOString(), message: fallback };
    return fallback;
  });
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
): Promise<{ name: string; worktree: string; status: WorkspaceStatus }> {
  const { config, registryDir } = kernel;
  if (command.full && config.devServerScript === undefined) {
    throw new WorkspaceError(
      "`--full` runs the dev setup, but the workspace config declares no `devServerScript`.",
    );
  }
  const setupCtx = ensureWorktree(command, ctx, run, config.worktreeDirName);
  refuseIfFinalizePending(setupCtx, registryDir, command.force);
  const branch = getWorktreeBranch(setupCtx.currentWorktree) ?? "(detached)";
  const { name, status } = await registerWorkspace({
    currentWorktree: setupCtx.currentWorktree,
    mainWorktree: setupCtx.mainWorktree,
    registryDir,
    isMainWorktree: setupCtx.isMainWorktree,
    force: command.force,
  });
  const log = openSetupLog(setupCtx.currentWorktree, config.runtimeDir, run.verbose);

  // An error in this phase must not leave the entry `pending`: a plain `setup` retries a `failed` one.
  // A `ready` entry stays `ready`: the finalize outcome is unchanged and nothing forces a re-finalize.
  try {
    await prepareWorktree({ command, setupCtx, kernel, name, log, verbose: run.verbose });
    log.tee(
      await config.formatSummary({ ...setupCtx, name, branch, status, signal: config.signal }),
    );
  } catch (err) {
    const message = errorMessage(err);
    log.append(`FAILED: ${message}`);
    if (err instanceof Error && err.stack !== undefined) log.append(err.stack);
    closeSync(log.fd);
    if (status !== "ready") {
      await markWorkspaceFailed(
        setupCtx.mainWorktree,
        registryDir,
        setupCtx.currentWorktree,
        message,
      );
    }
    throw err;
  }

  log.tee(`WORKSPACE_CREATED path=${setupCtx.currentWorktree} branch=${branch}`);
  if (command.detached && status !== "ready") {
    log.tee(`Setup continuing in background. Tail: ${log.path}`);
    log.tee(`Join it with \`${waitCommand(setupCtx.currentWorktree, ctx.currentWorktree)}\`.`);
  }

  const finalizeArgs = [config.workspaceScript, "__finalize"];
  if (command.force) finalizeArgs.push("--force");
  if (command.full) finalizeArgs.push("--full");
  if (run.verbose) finalizeArgs.push("--verbose");
  const child = spawn(process.execPath, finalizeArgs, {
    detached: true,
    stdio: ["ignore", log.fd, log.fd],
    cwd: setupCtx.currentWorktree,
  });
  child.unref();
  closeSync(log.fd);
  return { name, worktree: setupCtx.currentWorktree, status };
}

interface SetupLog {
  fd: number;
  path: string;
  /** Writes to stdout and the log. */
  tee: (msg: string) => void;
  /** Writes to the log only. */
  append: (msg: string) => void;
  /** `tee` with `--verbose`, `append` otherwise. */
  verbose: (msg: string) => void;
}

function openSetupLog(worktree: string, runtimeDir: string, verbose: boolean): SetupLog {
  const path = setupLogPath(worktree, runtimeDir);
  mkdirSync(dirname(path), { recursive: true });
  // Truncate any prior log so `workspace setup` retries start with a clean record (the previous run's
  // FAILED: banner would otherwise linger and produce false positives for grep-based tooling).
  writeFileSync(path, "");
  rmSync(setupProgressPath(worktree, runtimeDir), { force: true });
  // Opened "a" so the same fd can be inherited by the detached finalize child.
  const fd = openSync(path, "a");
  const append = (msg: string): void => {
    appendFileSync(fd, `${msg}\n`);
  };
  const tee = (msg: string): void => {
    console.log(msg);
    append(msg);
  };
  return { fd, path, tee, append, verbose: verbose ? tee : append };
}

interface PrepareWorktreeInput {
  command: SetupCommand;
  setupCtx: WorktreeContext;
  kernel: Kernel;
  name: string;
  log: SetupLog;
  verbose: boolean;
}

/** The pre-finalize phase: hooks and file writes between registration and the summary. */
async function prepareWorktree(input: PrepareWorktreeInput): Promise<void> {
  const { command, setupCtx, kernel, name, log } = input;
  const { config } = kernel;
  if (config.preSetup) {
    await config.preSetup({
      ...setupCtx,
      name,
      force: command.force,
      verbose: input.verbose,
      signal: config.signal,
      log: log.tee,
    });
  }
  linkSharedDirectories(setupCtx, config.sharedDirs, log.verbose);
  linkWorkspaceRegistry(setupCtx, config.runtimeDir, log.verbose);
  const patchCtx: PatchContext = {
    name,
    mainWorktree: setupCtx.mainWorktree,
    currentWorktree: setupCtx.currentWorktree,
    isMainWorktree: setupCtx.isMainWorktree,
    signal: config.signal,
  };
  await seedFiles({
    entries: config.gitignoredFiles,
    ctx: patchCtx,
    existing: command.force ? "reseed" : "patch",
    log,
  });
}

/**
 * The `wait` command to suggest for a worktree: no argument when it is the current worktree (the
 * common case), otherwise selected by its absolute path.
 */
function waitCommand(worktree: string, currentWorktree: string): string {
  if (resolve(worktree) === resolve(currentWorktree)) return wsCmd("wait");
  return wsCmd(`wait '${worktree.replaceAll("'", "'\\''")}'`);
}

function refuseIfFinalizePending(ctx: WorktreeContext, registryDir: string, force: boolean): void {
  if (force) return;
  const found = findWorkspaceByPath(
    readWorkspaces(ctx.mainWorktree, registryDir),
    ctx.currentWorktree,
  );
  if (found?.entry.status !== "pending") return;
  const { name } = found;
  console.error(
    `Error: Setup is already in progress for workspace ${name}. ` +
      `Run \`${wsCmd("wait")}\` to wait for it to finish (or fail), then retry. ` +
      "Use --force to bypass.",
  );
  process.exit(1);
}

type FinalizeCommand = Extract<WorkspaceCommand, { kind: "finalize" }>;

async function runFinalize(
  command: FinalizeCommand,
  kernel: Kernel,
  ctx: WorktreeContext,
  verbose: boolean,
): Promise<void> {
  const { config, registryDir } = kernel;
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
  const found = findWorkspaceByPath(registry, ctx.currentWorktree);
  if (!found) {
    appendLog(`FAILED: No workspace registered for worktree ${ctx.currentWorktree}.`);
    process.exit(1);
  }
  const { name, entry } = found;

  const branch = getWorktreeBranch(ctx.currentWorktree) ?? "(detached)";

  if (entry.status === "ready" && !command.force) {
    appendLog(`READY: branch ${branch} (workspace ${name}) already finalized; skipping.`);
    return;
  }

  appendLog(`--- finalizing workspace ${name} at ${new Date().toISOString()} ---`);

  const setupContext: FinalizeContext = {
    currentWorktree: ctx.currentWorktree,
    mainWorktree: ctx.mainWorktree,
    isMainWorktree: ctx.isMainWorktree,
    name,
    branch,
    force: command.force,
    verbose,
    signal: config.signal,
    progress,
  };

  try {
    const result: unknown = await config.finalizeWorkspace(setupContext);
    if (result !== undefined) {
      throw new ConfigError(
        "`finalizeWorkspace` returned a value: purge data is no longer stored. Provision " +
          `infrastructure in the dev-server's \`setup\` and tear it down by name. ${UPGRADE_POINTER}`,
      );
    }
  } catch (err) {
    const message = (err as Error).message;
    const stack = (err as Error).stack ?? "";
    await markWorkspaceFailed(ctx.mainWorktree, registryDir, ctx.currentWorktree, message);
    rmSync(progressPath, { force: true });
    appendLog(`FAILED: ${message}`);
    if (stack) appendLog(stack);
    process.exit(1);
  }

  // `ready` means the workspace's own setup succeeded: a dev failure is only recorded.
  if (command.full) {
    progress("Dev setup");
    const failure = await runDevSetupChild({
      kernel,
      mainWorktree: ctx.mainWorktree,
      worktree: ctx.currentWorktree,
      fromFinalize: true,
      force: command.force,
      verbose,
    });
    if (failure !== undefined) appendLog(`DEV SETUP FAILED: ${failure}`);
  }
  await markWorkspaceReady(ctx.mainWorktree, registryDir, ctx.currentWorktree);
  rmSync(progressPath, { force: true });
  appendLog("============================================================");
  appendLog(`READY: branch ${branch} (workspace ${name})`);
  appendLog("============================================================");
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
  const resolved = resolveCurrentWorkspace(ctx.mainWorktree, registryDir, ctx.currentWorktree);
  return { name: resolved.name, worktree: resolved.worktree, main: resolved.main ?? false };
}

function targetFromDir(dir: string, registry: WorkspacesRegistry): ResolvedTarget {
  const name = matchWorktreeByDir(dir, registry, process.cwd());
  if (name === undefined) {
    console.error(
      `Error: No workspace matching "${dir}" (by path or registered name). Run \`${wsCmd("list")}\`.`,
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
  return (
    findWorkspaceByPath(registry, resolve(cwd, dir))?.name ??
    (Object.hasOwn(registry.workspaces, dir) ? dir : undefined)
  );
}

async function printWorktreeInfo(
  kernel: Kernel,
  target: ResolvedTarget,
  worktreeForLog: string,
): Promise<void> {
  const { config, registryDir } = kernel;
  const ctx = detectWorktree();
  const found = findWorkspaceByPath(readWorkspaces(ctx.mainWorktree, registryDir), target.worktree);
  const entry = found?.entry;

  const status: WorkspaceStatus = entry?.status ?? "pending";
  const setupLog = setupLogPath(worktreeForLog, config.runtimeDir);
  const now = Date.now();
  const isMainWorktree = entry?.main ?? target.main;
  const targetWorktree = entry?.worktree ?? ctx.currentWorktree;
  const branch = getWorktreeBranch(targetWorktree) ?? "(detached)";
  console.log(
    await config.formatSummary({
      name: found?.name ?? target.name,
      branch,
      currentWorktree: targetWorktree,
      mainWorktree: ctx.mainWorktree,
      isMainWorktree,
      status,
      signal: config.signal,
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
  if (entry) printDevSetupState(entry, now);
  if (config.devServerScript !== undefined) {
    printDevServerBlock(config, registryDir, ctx.mainWorktree, targetWorktree, now);
  }
}

/** The ports `dev setup` allocated, and its last failure. */
function printDevSetupState(entry: WorkspaceEntry, now: number): void {
  if (hasPorts(entry)) console.log(`Ports: ${formatPorts(entry.ports)}`);
  const failure = entry.devSetupFailure;
  if (failure === undefined) return;
  const elapsed = formatDuration(now - Date.parse(failure.at));
  console.log(`Dev setup failed: ${failure.message} (${elapsed} ago)`);
}

function hasPorts(
  entry: WorkspaceEntry,
): entry is WorkspaceEntry & { ports: Record<string, number> } {
  return entry.ports !== undefined && Object.keys(entry.ports).length > 0;
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
    console.log(
      `    log: ${join(targetWorktree, config.runtimeDir, "logs", `${encodeURIComponent(name)}.log`)}`,
    );
  }
}

type StatusCommand = Extract<WorkspaceCommand, { kind: "status" }>;

async function runStatus(command: StatusCommand, kernel: Kernel): Promise<void> {
  const ctx = detectWorktree();
  const target = resolveTarget(command.selector, ctx, kernel.registryDir);
  await printWorktreeInfo(kernel, target, target.worktree);
}

async function runList(kernel: Kernel): Promise<void> {
  const { registryDir } = kernel;
  const ctx = detectWorktree();
  const retainedOrphans = await autoPruneSafeOrphans(ctx.mainWorktree, registryDir);
  const entries = sortedEntries(readWorkspaces(ctx.mainWorktree, registryDir));
  if (entries.length === 0) {
    console.log("No workspaces registered.");
    hintRetainedOrphans(retainedOrphans);
    return;
  }
  const liveSet = liveWorktrees(readDevServers(ctx.mainWorktree, registryDir));
  const showPorts = entries.some(([, entry]) => hasPorts(entry));
  const headers = ["NAME", "TYPE", "STATUS", "DEV"];
  if (showPorts) headers.push("PORTS");
  headers.push("BRANCH", "PATH", "CREATED");
  const rows = entries.map(([name, entry]) => {
    const cells = [
      name,
      entry.main ? "main" : "linked",
      entry.status,
      liveSet.has(resolve(entry.worktree)) ? "up" : "-",
    ];
    if (showPorts) cells.push(hasPorts(entry) ? Object.values(entry.ports).join(",") : "-");
    cells.push(getWorktreeBranch(entry.worktree) ?? "(detached)", entry.worktree, entry.createdAt);
    return cells;
  });
  for (const line of renderTable(headers, rows)) console.log(line);
  hintRetainedOrphans(retainedOrphans);
}

/** Main worktree first, then by workspace name. */
function sortedEntries(registry: WorkspacesRegistry): [string, WorkspaceEntry][] {
  return Object.entries(registry.workspaces).sort(([nameA, a], [nameB, b]) => {
    if (a.main !== b.main) return a.main ? -1 : 1;
    return nameA.localeCompare(nameB);
  });
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
 * harmless bookkeeping, consistent with the existing dead-PID pruning. Failed entries retain their
 * cleanup identity for purge retries. Failed or live orphans need explicit `workspace prune` and
 * are returned so the caller can hint about them.
 */
async function autoPruneSafeOrphans(mainWorktree: string, registryDir: string): Promise<string[]> {
  // Checked without the lock first: a plain `list` with no orphan writes nothing.
  if (findOrphanNames(readWorkspaces(mainWorktree, registryDir)).length === 0) return [];
  return updateWorkspaces(mainWorktree, registryDir, (registry) => {
    const live = liveWorktrees(readDevServers(mainWorktree, registryDir));
    const retainedOrphans: string[] = [];
    for (const name of findOrphanNames(registry)) {
      const entry = registry.workspaces[name];
      if (entry.status === "failed" || live.has(resolve(entry.worktree))) {
        retainedOrphans.push(name);
        continue;
      }
      delete registry.workspaces[name];
      removeDevServerEntryByWorktree(mainWorktree, registryDir, entry.worktree);
    }
    return retainedOrphans;
  });
}

function hintRetainedOrphans(retainedOrphans: string[]): void {
  if (retainedOrphans.length === 0) return;
  console.log(
    `\nNote: ${retainedOrphans.length} workspace(s) have a deleted worktree and need explicit ` +
      `cleanup. Run \`${wsCmd("prune")}\` to clean up.`,
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
    stoppedProcesses += await cleanupTarget(
      kernel,
      ctx,
      {
        worktree: entry.worktree,
        mainWorktree: ctx.mainWorktree,
        name,
        purgeData: entry.purgeData,
        verbose,
      },
      true,
    );
    console.log(`Pruned workspace ${name} (${entry.worktree}).`);
  }

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

async function cleanupTarget(
  kernel: Kernel,
  ctx: WorktreeContext,
  target: PurgeContext,
  orphanOnly = false,
): Promise<number> {
  const { config, registryDir } = kernel;
  if (!orphanOnly || existsSync(target.worktree)) {
    refusePendingCleanup(ctx, registryDir, target.worktree);
  }
  await retainCleanupIdentity(ctx, registryDir, target);
  const log = makeVerboseLog(target.verbose);
  if (config.devServerScript === undefined) {
    log("No dev-server script configured; skipping stop.");
  } else if (
    existsSync(target.worktree) &&
    findOwnEntry(ctx.mainWorktree, registryDir, target.worktree)
  ) {
    stopTargetDevServer(config.devServerScript, target.worktree, log);
  }
  const leftover = await killRecordedDevServer(ctx.mainWorktree, registryDir, target.worktree);
  if (leftover > 0) {
    console.warn(
      `Warning: Killed ${leftover} dev-server process(es) left running; the configured callback ` +
        "`stop()` did not run.",
    );
  }
  await runPurgeInfrastructure(config, target);
  if (orphanOnly) {
    await deleteOrphanEntries(ctx.mainWorktree, registryDir, target.worktree);
  } else {
    await deleteWorkspaceEntry(ctx.mainWorktree, registryDir, target.worktree);
  }
  return leftover;
}

/** A stop wrapper can unregister the only dev record before infrastructure purge has succeeded. */
async function retainCleanupIdentity(
  ctx: WorktreeContext,
  registryDir: string,
  target: PurgeContext,
): Promise<void> {
  await updateWorkspaces(ctx.mainWorktree, registryDir, (registry) => {
    if (findWorkspaceByPath(registry, target.worktree)) return;
    if (Object.hasOwn(registry.workspaces, target.name)) {
      throw new WorkspaceError(`Workspace name ${target.name} belongs to a different worktree.`);
    }
    const now = new Date().toISOString();
    registry.workspaces[target.name] = {
      worktree: resolve(target.worktree),
      createdAt: now,
      status: "failed",
      failure: { at: now, message: "Infrastructure cleanup incomplete; retry workspace teardown." },
      ...(resolve(target.worktree) === resolve(ctx.mainWorktree) ? { main: true } : {}),
    };
  });
}

function refusePendingCleanup(ctx: WorktreeContext, registryDir: string, worktree: string): void {
  const found = findWorkspaceByPath(readWorkspaces(ctx.mainWorktree, registryDir), worktree);
  if (found?.entry.status !== "pending") return;
  throw new WorkspaceError(
    `Setup is still in progress for workspace ${found.name}. ` +
      `Run \`${waitCommand(worktree, ctx.currentWorktree)}\` to wait for it to finish (or fail), then retry.`,
  );
}

/**
 * Stop a dev-server without its `dev down`: the worktree (and `dev-server.mjs`) is deleted, or its
 * `dev down` failed. Kills the recorded spawn PIDs directly and drops the dev-server entry; callback
 * stop() does not run. Returns the count of live PIDs stopped. The caller separately runs
 * `purgeInfrastructure` (by workspace name; a legacy entry also passes its `purgeData`) to tear down
 * callback-managed infra.
 */
async function killRecordedDevServer(
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

async function runPurgeInfrastructure(config: WorkspaceConfig, ctx: PurgeContext): Promise<void> {
  if (config.purgeInfrastructure) {
    await config.purgeInfrastructure({ ...ctx, signal: ctx.signal ?? config.signal });
  }
}

/** Runs after the teardown, on a fresh read: the lock never spans a callback, git or Docker. */
async function deleteWorkspaceEntry(
  mainWorktree: string,
  registryDir: string,
  worktree: string,
): Promise<void> {
  await updateWorkspaces(mainWorktree, registryDir, (registry) => {
    const found = findWorkspaceByPath(registry, worktree);
    if (found) delete registry.workspaces[found.name];
  });
}

/** Deletes the pruned entry only while its captured path is still orphaned on a fresh read. */
async function deleteOrphanEntries(
  mainWorktree: string,
  registryDir: string,
  worktree: string,
): Promise<void> {
  await updateWorkspaces(mainWorktree, registryDir, (registry) => {
    const found = findWorkspaceByPath(registry, worktree);
    if (found && findOrphanNames(registry).includes(found.name)) {
      delete registry.workspaces[found.name];
    }
  });
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
  await waitForWorkspace(target, kernel, { verbose, replayLog: true, full: true });
}

interface WaitOptions {
  formatSummary?: boolean;
  verbose?: boolean;
  replayLog?: boolean;
  /** A `ready` entry with a `devSetupFailure` is reported as a failure. */
  full?: boolean;
}

async function waitForWorkspace(
  target: Pick<ResolvedTarget, "name" | "worktree">,
  kernel: Kernel,
  options: WaitOptions = {},
): Promise<void> {
  const { name, worktree } = target;
  const { config, registryDir } = kernel;
  const formatSummary = options.formatSummary ?? true;
  const ctx = detectWorktree();
  const initial = findWorkspaceByPath(
    readWorkspaces(ctx.mainWorktree, registryDir),
    worktree,
  )?.entry;
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
    const found = findWorkspaceByPath(
      readWorkspaces(ctx.mainWorktree, registryDir),
      initial.worktree,
    );
    if (!found) {
      ticker.stop();
      console.error(`Error: Workspace "${name}" disappeared from registry.`);
      process.exit(1);
    }
    const { entry } = found;
    if (entry.status === "ready") {
      ticker.stop();
      if (options.full && entry.devSetupFailure !== undefined) {
        console.error(devSetupFailedMessage(entry.devSetupFailure.message));
        process.exit(1);
      }
      console.log("… ready");
      if (formatSummary) {
        const target: ResolvedTarget = {
          name: found.name,
          worktree: entry.worktree,
          main: entry.main ?? false,
        };
        await printWorktreeInfo(kernel, target, entry.worktree);
      }
      return;
    }
    if (entry.status === "failed") {
      ticker.stop();
      console.error(`FAILED: ${entry.failure?.message ?? "(no message)"}`);
      console.error(`Full log: ${setupLogPath(entry.worktree, config.runtimeDir)}`);
      printForeignScriptHint(config.workspaceScript, entry.worktree);
      process.exit(1);
    }
    ticker.tick();
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * A setup started from another worktree ran that worktree's scripts, not the target branch's. When
 * they differ, a retry from inside the target uses the branch's own.
 */
function printForeignScriptHint(workspaceScript: string, worktree: string): void {
  const rel = relative(worktree, workspaceScript);
  if (!rel.startsWith("..") && !isAbsolute(rel)) return;
  console.error(
    `This setup ran the workspace scripts of another worktree. If the branch's own scripts ` +
      `differ, run \`${wsCmd("setup")}\` from inside ${worktree}.`,
  );
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

type TeardownCommand = Extract<WorkspaceCommand, { kind: "teardown" }>;

async function handleTeardown(
  command: TeardownCommand,
  ctx: WorktreeContext,
  run: RunCtx,
  kernel: Kernel,
): Promise<void> {
  const target = resolveCleanupTarget(command.selector, ctx, kernel.registryDir);
  if (!target.identity) {
    console.log(`Worktree ${target.worktree} is already torn down.`);
    return;
  }
  await cleanupTarget(kernel, ctx, {
    ...target.identity,
    worktree: target.worktree,
    mainWorktree: ctx.mainWorktree,
    verbose: run.verbose,
  });
  console.log(
    `Tore down workspace ${target.identity.name}. Worktree files and Git registration kept.`,
  );
}

interface CleanupTarget {
  worktree: string;
  identity?: { name: string; purgeData?: unknown };
}

function resolveCleanupTarget(
  selector: WorkspaceSelector,
  ctx: WorktreeContext,
  registryDir: string,
): CleanupTarget {
  const registry = readWorkspaces(ctx.mainWorktree, registryDir);
  const devServers = readDevServers(ctx.mainWorktree, registryDir).servers;
  const path = resolve(selector.dir ?? ctx.currentWorktree);
  const workspace = findWorkspaceByPath(registry, path);
  if (workspace) {
    return {
      worktree: path,
      identity: { name: workspace.name, purgeData: workspace.entry.purgeData },
    };
  }
  const dev = devServers.find((entry) => resolve(entry.worktree) === path);
  if (dev) return { worktree: path, identity: { name: dev.name } };

  if (selector.dir !== undefined) {
    const entry = registry.workspaces[selector.dir];
    if (Object.hasOwn(registry.workspaces, selector.dir)) {
      return {
        worktree: entry.worktree,
        identity: { name: selector.dir, purgeData: entry.purgeData },
      };
    }
    const namedDev = devServers.find((entry) => entry.name === selector.dir);
    if (namedDev) {
      const owner = findWorkspaceByPath(registry, namedDev.worktree);
      return {
        worktree: resolve(namedDev.worktree),
        identity: owner
          ? { name: owner.name, purgeData: owner.entry.purgeData }
          : { name: namedDev.name },
      };
    }
  }

  try {
    const target = detectWorktree(path);
    if (
      resolve(target.currentWorktree) === path &&
      resolve(target.mainWorktree) === resolve(ctx.mainWorktree)
    )
      return { worktree: path };
  } catch {
    // An unregistered target must be verified through Git before accepting a no-op.
  }
  throw new WorkspaceError(
    `No workspace matching "${selector.dir ?? path}" (by path or registered name), ` +
      "or the path is not a worktree of this repository.",
  );
}

type RemoveCommand = Extract<WorkspaceCommand, { kind: "remove" }>;

async function handleRemove(
  command: RemoveCommand,
  ctx: WorktreeContext,
  run: RunCtx,
  kernel: Kernel,
): Promise<void> {
  const { registryDir } = kernel;
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

  refusePendingCleanup(ctx, registryDir, worktree);
  const cleanup: PurgeContext = {
    worktree,
    mainWorktree: ctx.mainWorktree,
    name,
    purgeData: registry.workspaces[name]?.purgeData,
    verbose: run.verbose,
  };

  if (!existsSync(worktree)) {
    console.warn(`Warning: Worktree directory ${worktree} not found. Cleaning up registry only.`);
    await cleanupTarget(kernel, ctx, cleanup);
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

  await cleanupTarget(kernel, ctx, cleanup);

  if (removeHere) process.chdir(ctx.mainWorktree);

  removeWorktree(worktree, run);

  console.log(`Removed workspace ${name} (branch "${branch}"). Branch "${branch}" kept.`);
  if (removeHere) console.log(`Now run: cd ${ctx.mainWorktree}`);
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
      // A dead symlink (e.g. `.plans` pointing at a moved clone of the work-files repository) must be repaired by the
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
    const linkStat = lstatSync(link, { throwIfNoEntry: false });
    if (linkStat !== undefined && !linkNeedsRepair(link, linkStat.isSymbolicLink(), mainDir)) {
      log(`Skipped ${dirName} symlink (already exists).`);
    } else {
      if (linkStat !== undefined) unlinkSync(link);
      mkdirSync(dirname(link), { recursive: true });
      const relTarget = relative(dirname(link), mainDir);
      symlinkSync(relTarget, link);
      log(`Created ${dirName} symlink → main worktree.`);
    }
  }
  if (!ctx.isMainWorktree) excludeSharedLinks(ctx.currentWorktree, dirs, log);
}

function linkNeedsRepair(link: string, symbolicLink: boolean, mainDir: string): boolean {
  if (!symbolicLink) return false;
  return resolve(dirname(link), readlinkSync(link)) !== resolve(mainDir);
}

/**
 * A shared directory materializes as a symlink in the linked worktree, and a
 * directory-shaped gitignore pattern (`.plans/`, `.plans/**`) does not match a
 * symlink — the worktree would read as dirty from birth and `workspace remove`
 * would refuse the tooling's own creation. The tooling configures a private
 * excludes file for this worktree, never the shared `.git/info/exclude`.
 */
function excludeSharedLinks(worktree: string, dirs: string[], log: (msg: string) => void): void {
  if (dirs.length === 0) return;
  try {
    const gitDirectory = execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
      cwd: worktree,
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
    const excludePath = join(gitDirectory, "workspace-shared-exclude");
    const inheritedExcludeFiles = configuredExcludeFiles(worktree, excludePath);
    writeSharedExcludes(excludePath, inheritedExcludeFiles, dirs);
    execFileSync("git", ["config", "extensions.worktreeConfig", "true"], {
      cwd: worktree,
      stdio: "pipe",
    });
    execFileSync("git", ["config", "--worktree", "core.excludesFile", excludePath], {
      cwd: worktree,
      stdio: "pipe",
    });
    log(`Excluded shared symlinks in this worktree (${dirs.map((dir) => `/${dir}`).join(", ")}).`);
  } catch {
    log(`Skipped shared-symlink exclusion (unavailable in ${worktree}).`);
  }
}

function configuredExcludeFiles(worktree: string, managedPath: string): string[] {
  const result = spawnSync(
    "git",
    ["config", "--null", "--path", "--get-all", "core.excludesFile"],
    {
      cwd: worktree,
      encoding: "utf-8",
      stdio: "pipe",
    },
  );
  if (result.status === 1) return [];
  if (result.status !== 0)
    throw new Error(result.stderr.trim() || "cannot read Git excludes files");
  return result.stdout.split("\0").filter((path) => path !== "" && path !== managedPath);
}

function writeSharedExcludes(excludePath: string, inheritedFiles: string[], dirs: string[]): void {
  const inherited = inheritedFiles
    .filter((path) => existsSync(path))
    .map((path) => readFileSync(path, "utf-8").trimEnd())
    .filter((content) => content !== "")
    .join("\n");
  const lines = new Set(inherited.split("\n"));
  const missing = dirs.map((dirName) => `/${dirName}`).filter((entry) => !lines.has(entry));
  mkdirSync(dirname(excludePath), { recursive: true });
  writeFileSync(
    excludePath,
    `${[inherited, ...missing].filter((part) => part !== "").join("\n")}\n`,
  );
}

/**
 * Symlinks the linked worktree's `${runtimeDir}/workspace-registry` to the main worktree's, so a
 * linked worktree's `runtimeDir` has the same layout as main's. The kernel reads the registry from
 * the main worktree. `runtimeDir` is per-worktree and not in `sharedDirs`, so this is distinct from
 * {@link linkSharedDirectories}.
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

/** Runs the configured absolute dev-server wrapper with target cwd; no cross-branch discovery. */
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
