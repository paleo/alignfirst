import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { canonicalPath, readRepository, worktreeRoot } from "./git.js";
import { assertDeletionSafe } from "./deletion-safety.js";
import { readWorkspaceInventory, selectWorkspaceRecord } from "./inventory.js";
import { assertReservedCommit, planPreparation, validateMainBaseline } from "./preparation.js";

import {
  renderWorkspaceHelp,
  workspaceVersion,
  type ParsedWorkspaceArgs,
  type WorkspaceCommand,
  type WorkspaceSelector,
} from "./cli.js";
import {
  findOwnEntry,
  liveWorktrees,
  readDevServers,
  completeDevServerCleanup,
  markDevServerCleanupPending,
  assertNoPendingCleanup,
} from "./dev-servers-registry.js";
import { errorMessage, WorkspaceError } from "./errors.js";
import {
  type GitignoredFileEntry,
  type PatchContext,
  type SetupContextBase,
  seedFiles,
} from "./file-entries.js";
import { renderGuide } from "./guide.js";
import { formatDuration, setupLogPath, setupProgressPath } from "./helpers.js";
import { followLogFile, LOG_TAIL_LINES, replayTail } from "./log-polling.js";
import { findOrphanNames } from "./orphans.js";
import { defaultCommands, devCmd, installedCliCommand, wsCmd } from "./invocation.js";
import type { WorkspaceOperation, WorkspaceOutput } from "./operation.js";
import type { WorkspaceStorage } from "./storage.js";
import type { WorkspaceManifest } from "./config.js";
import { executeCommand } from "./command-executor.js";
import { stopTarget } from "./target-stop.js";
import { formatPorts } from "./ports.js";
import { isProcessAlive, stopProcessGroup } from "./process-control.js";
import { assertRegistryOwnership } from "./registry-ownership.js";
import { runtimeDirForTarget, resolveWorkspaceStorage } from "./storage.js";
import { assertRuntimeOwnership } from "./runtime-ownership.js";
import {
  assertWorkspaceRecipe,
  assertWorkspaceCleanupComplete,
  type WorkspaceRecipe,
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

/** Configuration accepted by {@link runWorkspace}. */
export interface WorkspaceConfig {
  signal?: AbortSignal;
  recipe: WorkspaceRecipe;
  /** Validated host-selected recipe sections, without project discovery in the kernel. */
  settings?: WorkspaceManifest;
  configurationDir?: string;
  companionDir?: string;
  storage?: WorkspaceStorage;
  hasDevServer: boolean;
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
  finalizeWorkspace?: (ctx: FinalizeContext) => Promise<void> | void;
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
  recipe: WorkspaceRecipe;
  verbose: boolean;
}

/** Per-invocation state shared by every command flow. */
interface Kernel extends WorkspaceOperation {
  config: WorkspaceConfig;
  /** Absolute shared registry address, independent of the target runtime directory. */
  registryDir: string;
}

export interface WorkspaceOutcome {
  name: string;
  worktree: string;
  status: WorkspaceStatus;
}

export async function runWorkspace(
  config: WorkspaceConfig,
  operation: WorkspaceOperation & ParsedWorkspaceArgs,
): Promise<WorkspaceOutcome | undefined> {
  const { command, verbose, output } = operation;
  const commands = operation.commands ?? defaultCommands;
  if (command.kind === "help") {
    output.text(renderWorkspaceHelp(commands));
    return;
  }
  if (command.kind === "version") {
    output.text(workspaceVersion());
    return;
  }
  if (command.kind === "guide") {
    output.text(
      renderGuide(commands, {
        runtimeDir: config.runtimeDir,
        sharedDirs: config.sharedDirs,
        hasDevServer: config.hasDevServer,
      }),
    );
    return;
  }
  installedCliCommand(operation.invocation, []);
  const ctx = detectWorktree(operation.cwd);
  const kernel: Kernel = {
    ...operation,
    config,
    registryDir:
      config.storage?.registryDir ?? resolve(ctx.mainWorktree, registryDirFor(config.runtimeDir)),
  };
  assertRegistryOwnership(ctx.mainWorktree, ctx.currentWorktree, kernel.registryDir);
  readWorkspaces(ctx.mainWorktree, kernel.registryDir);
  readDevServers(ctx.mainWorktree, kernel.registryDir);

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

  const run: RunCtx = { verbose, cwd: operation.cwd, env: operation.env, output };

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
      if (command.enter) enterWorktree(worktree, kernel);
      const current = findWorkspaceByPath(
        readWorkspaces(ctx.mainWorktree, kernel.registryDir),
        worktree,
      );
      return { name: current?.name ?? name, worktree, status: current?.entry.status ?? status };
    }
  }
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
  throw new WorkspaceError(devSetupFailedMessage(failure));
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
 * Dispatches installed `alignfirst dev setup` in the target, routing child text through the caller.
 * Records a fallback failure when the child cannot record its own.
 */
async function runDevSetupChild(input: DevSetupChildInput): Promise<string | undefined> {
  const { kernel, mainWorktree, worktree } = input;
  if (!kernel.config.hasDevServer) throw new WorkspaceError("No dev services declared.");
  const startedAt = new Date().toISOString();
  const args = ["dev", "setup"];
  if (input.fromFinalize) args.push("--from-finalize");
  if (input.force) args.push("--force");
  if (input.verbose) args.push("--verbose");
  const child = installedCliCommand(kernel.invocation, args);
  let fallback: string;
  try {
    await executeCommand(
      { command: child.executable, args: child.args, cwd: worktree, env: kernel.env },
      {
        label: "dev setup",
        signal: kernel.config.signal,
        cooperativeCancellation: true,
        stdout: "stream",
        output: kernel.output,
      },
    );
    return;
  } catch (error) {
    fallback = errorMessage(error);
  }
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
function enterWorktree(worktree: string, kernel: Kernel): void {
  const shell = kernel.env.SHELL;
  if (shell === undefined || !process.stdin.isTTY) {
    printCdHint(worktree, kernel.output);
    return;
  }
  kernel.output.text(`Entering ${worktree} (exit to return).`);
  const result = spawnSync(shell, [], { cwd: worktree, env: kernel.env, stdio: "inherit" });
  if (result.error) {
    kernel.output.diagnostic(`Could not start ${shell}: ${result.error.message}`);
    printCdHint(worktree, kernel.output);
  }
}

function printCdHint(worktree: string, output: WorkspaceOutput): void {
  output.text(`Now run: cd '${worktree}'`);
}

type SetupCommand = Extract<WorkspaceCommand, { kind: "setup" }>;

async function runSetup(
  command: SetupCommand,
  ctx: WorktreeContext,
  run: RunCtx,
  kernel: Kernel,
): Promise<{ name: string; worktree: string; status: WorkspaceStatus }> {
  const { registryDir } = kernel;
  kernel.config.signal?.throwIfAborted();
  const protection =
    kernel.host === undefined
      ? undefined
      : await validateMainBaseline(ctx, kernel.host, kernel.env);
  const beforeCreate =
    protection === undefined
      ? undefined
      : (commit: string): void => {
          assertReservedCommit({ cwd: ctx.currentWorktree, env: kernel.env }, commit, protection);
        };
  kernel.config.signal?.throwIfAborted();
  const setupCtx = ensureWorktree(command, ctx, run, kernel.config.worktreeDirName, beforeCreate);
  let config = kernel.config;
  try {
    config = kernel.host?.loadWorkspace?.(setupCtx.currentWorktree) ?? config;
    kernel.config = config;
    const existing = findWorkspaceByPath(
      readWorkspaces(setupCtx.mainWorktree, registryDir),
      setupCtx.currentWorktree,
    );
    if (existing)
      assertWorkspaceRecipe(setupCtx.currentWorktree, existing.entry.recipe, config.recipe);
    assertWorkspaceCleanupComplete(existing?.entry);
    config.signal?.throwIfAborted();
    assertNoPendingCleanup(setupCtx.mainWorktree, registryDir, setupCtx.currentWorktree);
    refuseIfFinalizePending(setupCtx, registryDir, command.force);
    if (command.full && !config.hasDevServer)
      throw new WorkspaceError(
        "`--full` requires declared dev services in the workspace manifest.",
      );
    if (kernel.host) {
      const preparation = await planPreparation(
        setupCtx,
        kernel.host,
        kernel.env,
        config.sharedDirs,
        config.gitignoredFiles.map(({ path }) => path),
        kernel.output.diagnostic,
        kernel.registryDir,
      );
      config.signal?.throwIfAborted();
      await preparation.apply();
    }
    config.signal?.throwIfAborted();
  } catch (error) {
    throw setupRetry(error, setupCtx.currentWorktree);
  }
  const branch = getWorktreeBranch(setupCtx.currentWorktree) ?? "(detached)";
  const { name, status } = await registerWorkspace({
    currentWorktree: setupCtx.currentWorktree,
    mainWorktree: setupCtx.mainWorktree,
    registryDir,
    isMainWorktree: setupCtx.isMainWorktree,
    force: command.force,
    recipe: config.recipe,
  });
  if (config.storage)
    assertRuntimeOwnership(resolveWorkspaceStorage(config.storage, setupCtx.currentWorktree));
  const log = openSetupLog(
    runtimeDirForTarget(config, setupCtx.currentWorktree),
    run.verbose,
    kernel.output,
  );

  // An error in this phase must not leave the entry `pending`: a plain `setup` retries a `failed` one.
  // A `ready` entry stays `ready`: the finalize outcome is unchanged and nothing forces a re-finalize.
  try {
    config.signal?.throwIfAborted();
    await prepareWorktree({ command, setupCtx, kernel, name, log, verbose: run.verbose });
    const summary = await config.formatSummary({
      ...setupCtx,
      name,
      branch,
      status,
      signal: config.signal,
    });
    config.signal?.throwIfAborted();
    log.tee(summary);
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
    throw setupRetry(err, setupCtx.currentWorktree);
  }

  log.tee(`WORKSPACE_CREATED path=${setupCtx.currentWorktree} branch=${branch}`);
  const needsFinalizer =
    config.finalizeWorkspace !== undefined || (command.full && command.detached);
  if (command.detached && status !== "ready" && needsFinalizer) {
    log.tee(`Setup continuing in background. Tail: ${log.path}`);
    log.tee(`Join it with \`${waitCommand(setupCtx.currentWorktree, ctx.currentWorktree)}\`.`);
  }

  if (!needsFinalizer) {
    closeSync(log.fd);
    await markWorkspaceReady(setupCtx.mainWorktree, registryDir, setupCtx.currentWorktree);
    return { name, worktree: setupCtx.currentWorktree, status: "ready" };
  }
  const finalizeArgs = ["workspace", "__finalize"];
  if (command.force) finalizeArgs.push("--force");
  if (command.full) finalizeArgs.push("--full");
  if (run.verbose) finalizeArgs.push("--verbose");
  const invocation = installedCliCommand(kernel.invocation, finalizeArgs);
  const child = spawn(invocation.executable, invocation.args, {
    detached: true,
    stdio: ["ignore", log.fd, log.fd],
    cwd: setupCtx.currentWorktree,
    env: kernel.env,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
  } catch (error) {
    await markWorkspaceFailed(
      setupCtx.mainWorktree,
      registryDir,
      setupCtx.currentWorktree,
      "Could not launch finalizer.",
    );
    throw new WorkspaceError("Could not launch finalizer.", { cause: error });
  } finally {
    closeSync(log.fd);
  }
  return { name, worktree: setupCtx.currentWorktree, status };
}

function setupRetry(error: unknown, worktree: string): WorkspaceError {
  return new WorkspaceError(
    `${errorMessage(error)}\nRetained worktree ${worktree} and its Git state. Repair the reported problem, then retry with \`${wsCmd("setup")} --path '${worktree.replaceAll("'", "'\\''")}'\`. No rollback was attempted.`,
    { cause: error },
  );
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

function openSetupLog(runtimeDir: string, verbose: boolean, output: WorkspaceOutput): SetupLog {
  const path = setupLogPath(runtimeDir);
  mkdirSync(dirname(path), { recursive: true });
  // Truncate any prior log so `workspace setup` retries start with a clean record (the previous run's
  // FAILED: banner would otherwise linger and produce false positives for grep-based tooling).
  writeFileSync(path, "");
  rmSync(setupProgressPath(runtimeDir), { force: true });
  // Opened "a" so the same fd can be inherited by the detached finalize child.
  const fd = openSync(path, "a");
  const append = (msg: string): void => {
    appendFileSync(fd, `${msg}\n`);
  };
  const tee = (msg: string): void => {
    output.text(msg);
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
  config.signal?.throwIfAborted();
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
  config.signal?.throwIfAborted();
  if (!kernel.host) {
    linkSharedDirectories(setupCtx, config.sharedDirs, log.verbose);
    if (config.storage?.in !== "companion")
      linkWorkspaceRegistry(
        setupCtx,
        kernel.registryDir,
        runtimeDirForTarget(config, setupCtx.currentWorktree),
        log.verbose,
      );
  }
  const patchCtx: PatchContext = {
    name,
    mainWorktree: setupCtx.mainWorktree,
    currentWorktree: setupCtx.currentWorktree,
    isMainWorktree: setupCtx.isMainWorktree,
    signal: config.signal,
  };
  await seedFiles({
    registryDir: kernel.registryDir,
    entries: config.gitignoredFiles,
    ctx: patchCtx,
    existing: command.force ? "reseed" : "patch",
    log,
  });
  config.signal?.throwIfAborted();
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
  throw new WorkspaceError(
    `Setup is already in progress for workspace ${name}. ` +
      `Run \`${wsCmd("wait")}\` to wait for it to finish (or fail), then retry. ` +
      "Use --force to bypass.",
  );
}

type FinalizeCommand = Extract<WorkspaceCommand, { kind: "finalize" }>;

async function runFinalize(
  command: FinalizeCommand,
  kernel: Kernel,
  ctx: WorktreeContext,
  verbose: boolean,
): Promise<void> {
  const { config, registryDir } = kernel;
  if (config.storage)
    assertRuntimeOwnership(resolveWorkspaceStorage(config.storage, ctx.currentWorktree));
  const runtimeDir = runtimeDirForTarget(config, ctx.currentWorktree);
  const logPath = setupLogPath(runtimeDir);
  const progressPath = setupProgressPath(runtimeDir);
  if (kernel.host) {
    await validateMainBaseline(ctx, kernel.host, kernel.env);
    await kernel.host.validateWorkFiles(ctx.currentWorktree);
  }
  mkdirSync(dirname(logPath), { recursive: true });
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
    throw new WorkspaceError(`No workspace registered for worktree ${ctx.currentWorktree}.`);
  }
  const { name, entry } = found;
  assertWorkspaceRecipe(ctx.currentWorktree, entry.recipe, config.recipe);
  assertWorkspaceCleanupComplete(entry);
  config.signal?.throwIfAborted();

  const branch = getWorktreeBranch(ctx.currentWorktree) ?? "(detached)";

  if (entry.status === "ready" && entry.neverFinalized !== true && !command.force) {
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
    await config.finalizeWorkspace?.(setupContext);
    config.signal?.throwIfAborted();
  } catch (err) {
    const message = (err as Error).message;
    const stack = (err as Error).stack ?? "";
    await markWorkspaceFailed(ctx.mainWorktree, registryDir, ctx.currentWorktree, message);
    rmSync(progressPath, { force: true });
    appendLog(`FAILED: ${message}`);
    if (stack) appendLog(stack);
    throw new WorkspaceError(message, { cause: err });
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
  cwd: string,
): ResolvedTarget {
  const { dir } = selector;
  if (dir !== undefined) {
    return targetFromDir(dir, readWorkspaces(ctx.mainWorktree, registryDir), cwd);
  }
  const resolved = resolveCurrentWorkspace(ctx.mainWorktree, registryDir, ctx.currentWorktree);
  return { name: resolved.name, worktree: resolved.worktree, main: resolved.main ?? false };
}

function targetFromDir(dir: string, registry: WorkspacesRegistry, cwd: string): ResolvedTarget {
  const name = matchWorktreeByDir(dir, registry, cwd);
  if (name === undefined) {
    throw new WorkspaceError(
      `No workspace matching "${dir}" (by path or registered name). Run \`${wsCmd("list")}\`.`,
    );
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
  const ctx = detectWorktree(kernel.cwd);
  const found = findWorkspaceByPath(readWorkspaces(ctx.mainWorktree, registryDir), target.worktree);
  const entry = found?.entry;

  const status: WorkspaceStatus = entry?.status ?? "pending";
  const setupLog = setupLogPath(runtimeDirForTarget(config, worktreeForLog));
  const now = Date.now();
  const isMainWorktree = entry?.main ?? target.main;
  const targetWorktree = entry?.worktree ?? ctx.currentWorktree;
  const branch = getWorktreeBranch(targetWorktree) ?? "(detached)";
  kernel.output.text(
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
    kernel.output.text(`Failure: ${reason} (${elapsed} ago, tail ${setupLog})`);
  } else if (status === "pending" && entry) {
    const elapsed = formatDuration(now - Date.parse(entry.createdAt));
    kernel.output.text(`Pending since ${elapsed} ago (tail ${setupLog})`);
  }
  if (entry) printDevSetupState(entry, now, kernel.output);
  if (config.hasDevServer) {
    printDevServerBlock(config, registryDir, ctx.mainWorktree, targetWorktree, now, kernel.output);
  }
}

/** The ports `dev setup` allocated, and its last failure. */
function printDevSetupState(entry: WorkspaceEntry, now: number, output: WorkspaceOutput): void {
  if (hasPorts(entry)) output.text(`Ports: ${formatPorts(entry.ports)}`);
  const failure = entry.devSetupFailure;
  if (failure === undefined) return;
  const elapsed = formatDuration(now - Date.parse(failure.at));
  output.text(`Dev setup failed: ${failure.message} (${elapsed} ago)`);
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
  output: WorkspaceOutput,
): void {
  const entry = findOwnEntry(mainWorktree, registryDir, targetWorktree);
  const liveEntries = entry
    ? Object.entries(entry.pids)
        .filter(([, pid]) => isProcessAlive(pid))
        .sort(([a], [b]) => a.localeCompare(b))
    : [];
  if (liveEntries.length === 0 || !entry) {
    output.text(
      entry?.cleanupPending === true ? "Dev-server: cleanup pending" : "Dev-server: not running",
    );
    return;
  }
  const elapsed = formatDuration(now - Date.parse(entry.startedAt));
  output.text(`Dev-server: running, started ${elapsed} ago`);
  for (const [name, pid] of liveEntries) {
    output.text(`  ${name}: PID ${pid}`);
    output.text(
      `    log: ${join(runtimeDirForTarget(config, targetWorktree), "logs", `${encodeURIComponent(name)}.log`)}`,
    );
  }
}

type StatusCommand = Extract<WorkspaceCommand, { kind: "status" }>;

async function runStatus(command: StatusCommand, kernel: Kernel): Promise<void> {
  const ctx = detectWorktree(kernel.cwd);
  const inventory = readWorkspaceInventory(
    { cwd: kernel.cwd, env: kernel.env },
    kernel.registryDir,
  );
  const record = selectWorkspaceRecord(
    inventory,
    ctx.currentWorktree,
    command.selector.dir === undefined
      ? undefined
      : resolveSelector(command.selector.dir, kernel.cwd, inventory.workspaces),
  );
  if (record.preparation === "unprepared") {
    kernel.output.text(`${record.path}: unprepared (${record.branch ?? "detached"})`);
    return;
  }
  if (kernel.host?.loadWorkspace && record.exists)
    kernel.config = kernel.host.loadWorkspace(record.path);
  await printWorktreeInfo(
    kernel,
    { name: record.name ?? "", worktree: record.path, main: record.main },
    record.path,
  );
}

async function runList(kernel: Kernel): Promise<void> {
  const { registryDir } = kernel;
  const ctx = detectWorktree(kernel.cwd);
  const retainedOrphans = findOrphanNames(readWorkspaces(ctx.mainWorktree, registryDir));
  const inventory = readWorkspaceInventory({ cwd: kernel.cwd, env: kernel.env }, registryDir);
  const entries = inventory.workspaces;
  if (entries.length === 0) {
    kernel.output.text("No worktrees found.");
    hintRetainedOrphans(retainedOrphans, kernel.output);
    return;
  }
  const liveSet = liveWorktrees(readDevServers(ctx.mainWorktree, registryDir));
  const showPorts = entries.some((entry) => Object.keys(entry.ports).length > 0);
  const headers = ["NAME", "TYPE", "STATUS", "DEV"];
  if (showPorts) headers.push("PORTS");
  headers.push("BRANCH", "PATH");
  const rows = entries.map((entry) => {
    const cells = [
      entry.name ?? "-",
      entry.main ? "main" : "linked",
      entry.preparation,
      liveSet.has(resolve(entry.path)) ? "up" : "-",
    ];
    if (showPorts) cells.push(Object.values(entry.ports).join(",") || "-");
    cells.push(entry.branch ?? "(detached)", entry.path);
    return cells;
  });
  for (const line of renderTable(headers, rows)) kernel.output.text(line);
  hintRetainedOrphans(retainedOrphans, kernel.output);
}

function resolveSelector(
  selector: string,
  cwd: string,
  records: { name: string | null }[],
): string {
  return records.some((record) => record.name === selector)
    ? selector
    : canonicalPath(resolve(cwd, selector));
}

function renderTable(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => row[i].length)),
  );
  return [headers, ...rows].map((cells) =>
    cells.map((cell, i) => (i === cells.length - 1 ? cell : cell.padEnd(widths[i]))).join("  "),
  );
}

function hintRetainedOrphans(retainedOrphans: string[], output: WorkspaceOutput): void {
  if (retainedOrphans.length === 0) return;
  output.text(
    `\nNote: ${retainedOrphans.length} workspace(s) have a deleted worktree and need explicit ` +
      `cleanup. Run \`${wsCmd("prune")}\` to clean up.`,
  );
}

async function runPrune(kernel: Kernel, verbose: boolean): Promise<void> {
  const { registryDir } = kernel;
  const ctx = detectWorktree(kernel.cwd);
  const registry = readWorkspaces(ctx.mainWorktree, registryDir);
  const orphanNames = findOrphanNames(registry);

  let stoppedProcesses = 0;
  const failures: unknown[] = [];
  for (const name of orphanNames) {
    kernel.config.signal?.throwIfAborted();
    const entry = registry.workspaces[name];
    try {
      stoppedProcesses += await cleanupTarget(
        kernel,
        ctx,
        {
          worktree: entry.worktree,
          mainWorktree: ctx.mainWorktree,
          name,
          recipe: entry.recipe,
          verbose,
        },
        true,
      );
      kernel.output.text(`Pruned workspace ${name} (${entry.worktree}).`);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0)
    throw new AggregateError(failures, failures.map(errorMessage).join("; "));
  kernel.config.signal?.throwIfAborted();
  pruneGitWorktrees(ctx.mainWorktree);

  if (orphanNames.length === 0) {
    kernel.output.text("No orphaned workspaces to prune.");
    return;
  }
  kernel.output.text(`Pruned ${orphanNames.length} orphaned workspace(s).`);
  if (stoppedProcesses > 0) kernel.output.text(`Stopped ${stoppedProcesses} orphaned process(es).`);
}

async function cleanupTarget(
  kernel: Kernel,
  ctx: WorktreeContext,
  target: PurgeContext,
  orphanOnly = false,
): Promise<number> {
  const { registryDir } = kernel;
  const signal = target.signal ?? kernel.config.signal;
  signal?.throwIfAborted();
  const exists = existsSync(target.worktree);
  if (!orphanOnly || exists) refusePendingCleanup(ctx, registryDir, target.worktree);
  const recipeRoot = exists ? target.worktree : ctx.mainWorktree;
  const config = kernel.host?.loadWorkspace?.(recipeRoot) ?? kernel.config;
  assertWorkspaceRecipe(target.worktree, target.recipe, config.recipe);
  if (
    !exists &&
    target.recipe.kind === "manifest" &&
    (config.recipe.kind !== "manifest" || config.purgeInfrastructure === undefined)
  )
    throw new WorkspaceError(
      `Cannot purge manifest-backed orphan ${target.name}: restore a main-worktree manifest with its required purge recipe.`,
    );
  await retainCleanupIdentity(ctx, registryDir, target);
  const dev = findOwnEntry(ctx.mainWorktree, registryDir, target.worktree);
  let stopFailure: unknown;
  if (exists && dev) {
    try {
      await stopTarget({
        operation: kernel,
        mainWorktree: ctx.mainWorktree,
        registryDir,
        target: dev,
        signal,
        retainCleanup: true,
      });
    } catch (error) {
      stopFailure = error;
    }
  }
  signal?.throwIfAborted();
  const leftover = await killRecordedDevServer(ctx.mainWorktree, registryDir, target.worktree);
  if (leftover > 0)
    kernel.output.diagnostic(
      `Stopped ${leftover} recorded dev-server process(es) by PID fallback; recipe cleanup is still required.`,
    );
  if (stopFailure !== undefined) throw stopFailure;
  signal?.throwIfAborted();
  if (exists || target.recipe.kind === "manifest")
    await runPurgeInfrastructure(config, { ...target, signal });
  signal?.throwIfAborted();
  if (dev)
    await completeDevServerCleanup(
      ctx.mainWorktree,
      registryDir,
      target.worktree,
      dev.startedAt,
      dev.instanceId,
    );
  if (orphanOnly) {
    await deleteOrphanEntries(ctx.mainWorktree, registryDir, target.worktree);
  } else {
    await deleteWorkspaceEntry(ctx.mainWorktree, registryDir, target.worktree);
  }
  return leftover;
}

/** A stop child can release the dev record before infrastructure purge has succeeded. */
async function retainCleanupIdentity(
  ctx: WorktreeContext,
  registryDir: string,
  target: PurgeContext,
): Promise<void> {
  await updateWorkspaces(ctx.mainWorktree, registryDir, (registry) => {
    const existing = findWorkspaceByPath(registry, target.worktree)?.entry;
    if (existing) {
      existing.cleanupPending = true;
      return;
    }
    if (Object.hasOwn(registry.workspaces, target.name)) {
      throw new WorkspaceError(`Workspace name ${target.name} belongs to a different worktree.`);
    }
    const now = new Date().toISOString();
    registry.workspaces[target.name] = {
      worktree: resolve(target.worktree),
      createdAt: now,
      status: "failed",
      cleanupPending: true,
      recipe: target.recipe,
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

/** PID fallback retains both identities until the target's purge succeeds. */
async function killRecordedDevServer(
  mainWorktree: string,
  registryDir: string,
  worktree: string,
): Promise<number> {
  const devEntry = await markDevServerCleanupPending(mainWorktree, registryDir, worktree);
  if (!devEntry) return 0;
  let stopped = 0;
  for (const pid of Object.values(devEntry.pids)) {
    if (isProcessAlive(pid)) {
      await stopProcessGroup(pid);
      ++stopped;
    }
  }
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
    if (!found) return;
    if (findOrphanNames(registry).includes(found.name)) {
      delete registry.workspaces[found.name];
    } else delete found.entry.cleanupPending;
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
  const ctx = detectWorktree(kernel.cwd);
  const target = resolveTarget(command.selector, ctx, kernel.registryDir, kernel.cwd);
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
  const ctx = detectWorktree(kernel.cwd);
  const initial = findWorkspaceByPath(
    readWorkspaces(ctx.mainWorktree, registryDir),
    worktree,
  )?.entry;
  if (!initial) {
    throw new WorkspaceError(`No workspace "${name}" in registry.`);
  }

  const runtimeDir = runtimeDirForTarget(config, initial.worktree);
  const logPath = setupLogPath(runtimeDir);
  const progressPath = setupProgressPath(runtimeDir);
  const ticker = startSetupTicker(
    options.verbose ?? false,
    options.replayLog ?? false,
    logPath,
    progressPath,
    kernel.output,
  );

  const pollMs = 500;
  // Poll workspaces.json — the finalize child writes `status` on success or failure. Tiny file, no
  // log-tailing race.
  try {
    for (;;) {
      config.signal?.throwIfAborted();
      const found = findWorkspaceByPath(
        readWorkspaces(ctx.mainWorktree, registryDir),
        initial.worktree,
      );
      if (!found) {
        throw new WorkspaceError(`Workspace "${name}" disappeared from registry.`);
      }
      const { entry } = found;
      if (entry.status === "ready") {
        ticker.stop();
        if (options.full && entry.devSetupFailure !== undefined) {
          throw new WorkspaceError(devSetupFailedMessage(entry.devSetupFailure.message));
        }
        kernel.output.text("… ready");
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
        throw new WorkspaceError(
          `Setup failed: ${entry.failure?.message ?? "(no message)"}. Full log: ${setupLogPath(runtimeDirForTarget(config, entry.worktree))}`,
        );
      }
      ticker.tick();
      await new Promise((r) => setTimeout(r, pollMs));
    }
  } finally {
    ticker.stop();
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
  output: WorkspaceOutput,
): SetupTicker {
  if (verbose) {
    const offset = replayLog
      ? replayTail(logPath, "", LOG_TAIL_LINES, output.write)
      : existsSync(logPath)
        ? statSync(logPath).size
        : 0;
    const follower = followLogFile(logPath, "", offset, output.write);
    return { tick: () => {}, stop: follower.stop };
  }
  return startStatusLineTicker(logPath, progressPath, output);
}

function startStatusLineTicker(
  logPath: string,
  progressPath: string,
  output: WorkspaceOutput,
): SetupTicker {
  const isTty = output.isTTY;
  const startedAt = Date.now();
  let lastLabel: string | undefined;
  let printed = false;
  const render = (): void => {
    const label = readProgressLabel(progressPath);
    const labelPart = label !== undefined ? ` ${label}` : "";
    const line = `Finalizing…${labelPart} (${formatDuration(Date.now() - startedAt)}) — tail: ${logPath}`;
    if (isTty) {
      output.write(`\r\x1b[2K${line}`);
      printed = true;
    } else if (!printed || label !== lastLabel) {
      output.text(line);
      printed = true;
    }
    lastLabel = label;
  };
  return {
    tick: render,
    stop: () => {
      if (isTty && printed) output.write("\r\x1b[2K");
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
  const target = resolveCleanupTarget(command.selector, ctx, kernel.registryDir, kernel.cwd);
  if (!target.identity) {
    kernel.output.text(`Worktree ${target.worktree} is already torn down.`);
    return;
  }
  await cleanupTarget(kernel, ctx, {
    ...target.identity,
    worktree: target.worktree,
    mainWorktree: ctx.mainWorktree,
    verbose: run.verbose,
  });
  kernel.output.text(
    `Tore down workspace ${target.identity.name}. Worktree files and Git registration kept.`,
  );
}

interface CleanupTarget {
  worktree: string;
  identity?: { name: string; recipe: WorkspaceRecipe };
}

function resolveCleanupTarget(
  selector: WorkspaceSelector,
  ctx: WorktreeContext,
  registryDir: string,
  cwd: string,
): CleanupTarget {
  const registry = readWorkspaces(ctx.mainWorktree, registryDir);
  const devServers = readDevServers(ctx.mainWorktree, registryDir).servers;
  const path = resolve(cwd, selector.dir ?? ctx.currentWorktree);
  const workspace = findWorkspaceByPath(registry, path);
  if (workspace) {
    return {
      worktree: path,
      identity: { name: workspace.name, recipe: workspace.entry.recipe },
    };
  }
  const dev = devServers.find((entry) => resolve(entry.worktree) === path);
  if (dev) missingRecipeIdentity(path);

  if (selector.dir !== undefined) {
    const entry = registry.workspaces[selector.dir];
    if (Object.hasOwn(registry.workspaces, selector.dir)) {
      return {
        worktree: entry.worktree,
        identity: { name: selector.dir, recipe: entry.recipe },
      };
    }
    const namedDev = devServers.find((entry) => entry.name === selector.dir);
    if (namedDev) {
      const owner = findWorkspaceByPath(registry, namedDev.worktree);
      return {
        worktree: resolve(namedDev.worktree),
        identity: owner
          ? { name: owner.name, recipe: owner.entry.recipe }
          : missingRecipeIdentity(namedDev.worktree),
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

function missingRecipeIdentity(worktree: string): never {
  throw new WorkspaceError(
    `Missing durable workspace recipe identity for ${worktree}. Recover its registration before cleanup.`,
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
  const target = resolveCleanupTarget(command.selector, ctx, registryDir, kernel.cwd);
  const name = target.identity?.name ?? target.worktree;
  const worktree = target.worktree;
  await assertDeletionSafe({ cwd: kernel.cwd, env: kernel.env }, worktree, kernel.host);
  if (resolve(worktree) === resolve(ctx.mainWorktree)) {
    throw new WorkspaceError("Cannot remove the main worktree.");
  }
  const removeHere = resolve(worktree) === resolve(ctx.currentWorktree);
  if (removeHere) {
    const args = ["workspace", "remove", worktree];
    if (command.force) args.push("--force");
    if (run.verbose) args.push("--verbose");
    const child = installedCliCommand(kernel.invocation, args);
    await executeCommand(
      { command: child.executable, args: child.args, cwd: ctx.mainWorktree, env: kernel.env },
      {
        label: "workspace remove",
        signal: kernel.config.signal,
        cooperativeCancellation: true,
        stdout: "stream",
        output: kernel.output,
      },
    );
    return;
  }
  const branch = getWorktreeBranch(worktree) ?? "(detached)";

  refusePendingCleanup(ctx, registryDir, worktree);
  const cleanup: PurgeContext | undefined =
    target.identity === undefined
      ? undefined
      : {
          worktree,
          mainWorktree: ctx.mainWorktree,
          ...target.identity,
          verbose: run.verbose,
        };

  if (!existsSync(worktree)) {
    kernel.output.diagnostic(
      `Warning: Worktree directory ${worktree} not found. Cleaning up registry only.`,
    );
    if (cleanup) await cleanupTarget(kernel, ctx, cleanup);
    pruneGitWorktrees(ctx.mainWorktree);
    kernel.output.text(`Removed registry entry for workspace ${name} (branch "${branch}").`);
    return;
  }

  if (!command.force && isWorktreeDirty(worktree)) {
    throw new WorkspaceError(
      `Uncommitted changes in ${worktree}. Commit or stash them, or pass --force.`,
    );
  }

  if (cleanup) await cleanupTarget(kernel, ctx, cleanup);
  kernel.config.signal?.throwIfAborted();

  removeWorktree(worktree, { ...run, cwd: ctx.mainWorktree });

  kernel.output.text(`Removed workspace ${name} (branch "${branch}"). Branch "${branch}" kept.`);
  if (removeHere) kernel.output.text(`Now run: cd ${ctx.mainWorktree}`);
}

function ensureWorktree(
  command: SetupCommand,
  ctx: WorktreeContext,
  run: RunCtx,
  dirNameFn: WorktreeDirNameFn | undefined,
  beforeCreate?: (commit: string) => void,
): WorktreeContext {
  if (command.branch === undefined) {
    if (command.path === undefined) return ctx;
    const source = { cwd: run.cwd ?? ctx.currentWorktree, env: run.env ?? process.env };
    const repo = readRepository(source);
    const path = canonicalPath(resolve(source.cwd, command.path));
    const tree = repo.worktrees.find((tree) => tree.path === path && tree.exists);
    if (!tree || worktreeRoot({ ...source, cwd: path }) !== path)
      throw new WorkspaceError(
        `Setup requires an exact existing registered worktree root of this repository: ${path}`,
      );
    return { currentWorktree: path, mainWorktree: repo.mainWorktree, isMainWorktree: tree.main };
  }
  if (command.newBranch) {
    return createBranch(command.branch, ctx, run, {
      dirNameFn,
      from: command.from,
      dedupe: command.dedupe,
      path: command.path,
      beforeCreate,
    });
  }
  return useExistingBranch(command.branch, ctx, run, dirNameFn, {
    path: command.path,
    beforeCreate,
  });
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
    if (linkStat !== undefined) {
      if (!linkStat.isSymbolicLink() || realpathSync(link) !== realpathSync(mainDir))
        throw new WorkspaceError(`Conflicting shared directory destination: ${link}`);
      log(`Skipped ${dirName} symlink (already exists).`);
    } else {
      mkdirSync(dirname(link), { recursive: true });
      const relTarget = relative(dirname(link), mainDir);
      symlinkSync(relTarget, link);
      log(`Created ${dirName} symlink → main worktree.`);
    }
  }
  if (!ctx.isMainWorktree) excludeSharedLinks(ctx.currentWorktree, dirs, log);
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

/** Local mode only: link the target runtime registry to main's real registry directory. */
function linkWorkspaceRegistry(
  ctx: WorktreeContext,
  mainDir: string,
  runtimeRoot: string,
  log: (msg: string) => void,
): void {
  if (ctx.isMainWorktree) return;
  mkdirSync(mainDir, { recursive: true });
  mkdirSync(runtimeRoot, { recursive: true });
  const link = join(runtimeRoot, REGISTRY_SUBDIR);
  // lstat, not existsSync: existsSync follows symlinks, so a broken one would read as absent and
  // make symlinkSync throw EEXIST. A broken symlink is recreated even without `force`.
  const linkStat = lstatSync(link, { throwIfNoEntry: false });
  if (linkStat) {
    if (
      !linkStat.isSymbolicLink() ||
      !existsSync(link) ||
      realpathSync(link) !== realpathSync(mainDir)
    )
      throw new WorkspaceError(`Conflicting workspace-registry destination: ${link}`);
    log("Skipped workspace-registry symlink (already exists).");
    return;
  }
  symlinkSync(relative(runtimeRoot, mainDir), link);
  log("Created workspace-registry symlink → main worktree.");
}
