import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  parseWorkspaceArgs,
  printWorkspaceHelp,
  type WorkspaceCommand,
  type WorkspaceSelector,
} from "./cli.js";
import {
  findOwnEntry,
  liveWorktrees,
  mergeDevServers,
  readDevServers,
  removeDevServerEntryByWorktree,
  writeDevServers,
} from "./dev-servers-registry.js";
import { ConfigError } from "./errors.js";
import { printGuide } from "./guide.js";
import {
  copyAndPatchFile,
  formatDuration,
  type ResolvedFileSource,
  setupLogPath,
} from "./helpers.js";
import { findOrphanPorts } from "./orphans.js";
import { wsCmd } from "./package-manager.js";
import {
  defaultComputePorts,
  isReservedMainSlot,
  isValidPort,
  type PortScheme,
  resolvePortScheme,
} from "./ports.js";
import { isProcessAlive, stopProcessGroup } from "./process-control.js";
import {
  markSlotFailed,
  markSlotReady,
  mergeSlots,
  readSlots,
  REGISTRY_SUBDIR,
  registryDirFor,
  resolveAndRegisterSlot,
  resolveCurrentSlot,
  type SlotEntry,
  type SlotsRegistry,
  type SlotStatus,
  validateSlotAvailability,
  warnLegacyRegistryDir,
  writeSlots,
} from "./slots.js";
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
  scriptPath: string;
  /**
   * Absolute path to your dev-server script (the file that calls `runDevServer`). On
   * `workspace remove`, the kernel shells out to `node <devServerScript> down` with
   * `cwd: <target worktree>`. Typically
   * `fileURLToPath(new URL('./dev-server.mjs', import.meta.url))` from your `workspace.mjs`.
   */
  devServerScript: string;
  /** Anchor port for the slot range. Slots are derived from this value. */
  basePort: number;
  /** Distance between consecutive slots. Defaults to `10`. */
  portStep?: number;
  /** Maximum number of slots. Defaults to `19`. */
  maxSlotCount?: number;
  /** Custom port computation; takes precedence over `portNames`. */
  ports?: (slot: number) => Record<string, number>;
  /** Named offsets `[name0, name1, ...]` mapped to `slot+0`, `slot+1`, ... Required if `ports` is omitted. */
  portNames?: string[];
  /** Directories symlinked from the main worktree. */
  sharedDirs: string[];
  /**
   * Per-worktree runtime directory, relative to the worktree root (e.g. `.local-wt`).
   * Holds the setup log and dev-server logs.
   */
  runtimeDir: string;
  /** Gitignored files seeded into each worktree (from main, a committed template, or content) and patched per slot. */
  configFiles: ConfigFileEntry[];
  /**
   * Runs before `configFiles` are copied. Use this to bootstrap source files the kernel expects
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
   * May return `{ extra }` — an opaque blob persisted on the slot entry and handed back to
   * {@link purgeInfrastructure}, so an orphaned worktree can still be torn down after its config is gone.
   * Store only teardown identifiers you cannot re-derive at purge time (e.g. a random external resource
   * id). Deterministic names — containers, volumes — derive from `slot` + paths, so they don't belong here.
   */
  finalizeWorktree: (
    ctx: SetupContext,
  ) => Promise<FinalizeResult | undefined> | FinalizeResult | undefined;
  /**
   * Destructive infrastructure teardown (e.g. `docker compose down -v` to wipe volumes). Runs after
   * the dev-server stop on `workspace remove`, and on `workspace prune` / removing an orphaned
   * worktree. MUST be idempotent and tolerate already-absent infrastructure: it may run when the
   * worktree directory is gone (`ctx.extra` carries the recorded teardown identifiers; `ctx.worktree`
   * no longer exists), so branch on the worktree's presence and tear down by name in that case.
   * Best-effort; errors should be swallowed.
   */
  purgeInfrastructure?: (ctx: PurgeContext) => Promise<void> | void;
  /** Builds the post-setup summary printed to stdout. */
  printSummary: (ctx: SummaryContext) => string;
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

/** Return value of {@link WorkspaceConfig.finalizeWorktree}. */
export interface FinalizeResult {
  extra: unknown;
}

/** Context passed to {@link WorkspaceConfig.finalizeWorktree}. */
export interface SetupContext {
  currentWorktree: string;
  mainWorktree: string;
  /** `true` when finalizing the main worktree. Gate "copy from main" steps with `!isMainWorktree`. */
  isMainWorktree: boolean;
  slot: number;
  /** Live-resolved branch of `currentWorktree`. `"(detached)"` for detached HEAD. */
  branch: string;
  ports: Record<string, number>;
  force: boolean;
  verbose: boolean;
}

/**
 * Context passed to {@link WorkspaceConfig.printSummary}.
 *
 * Called after worktree creation; the dev-server is not running yet.
 */
export interface SummaryContext {
  slot: number;
  /** Live-resolved branch of `currentWorktree`. `"(detached)"` for detached HEAD. */
  branch: string;
  ports: Record<string, number>;
  currentWorktree: string;
  mainWorktree: string;
  /** `true` when the summary describes the main worktree (slot = `basePort`). */
  isMainWorktree: boolean;
  /** Slot finalize status. `"pending"` until `finalizeWorktree` succeeds, then `"ready"`. */
  status: SlotStatus;
}

/** Context passed to {@link WorkspaceConfig.purgeInfrastructure}. */
export interface PurgeContext {
  /** The target worktree. May no longer exist on disk when purging an orphan — check before
   * running cwd-bound commands; tear down by name (from {@link extra}) in that case. */
  worktree: string;
  mainWorktree: string;
  slot: number;
  /** The blob the consumer returned from `finalizeWorktree`, if any. */
  extra?: unknown;
  verbose: boolean;
}

/** One config file seeded from its source and patched per slot. */
export interface ConfigFileEntry {
  /** Path relative to the worktree root. Written to the current worktree. */
  path: string;
  /** Where the initial content comes from. */
  source: ConfigFileSource;
  /** Rewrites the source content per slot. Omit to copy the content verbatim. */
  patch?: (content: string, ctx: PatchContext) => string;
  /**
   * When `true`, a missing source file logs a warning and skips the entry instead of aborting.
   * Applies to `mainWorktree` and `newWorktree` sources; ignored for `content`.
   */
  optional?: boolean;
}

/** Where a {@link ConfigFileEntry}'s initial content comes from. */
export type ConfigFileSource =
  | MainWorktreeConfigFileSource
  | NewWorktreeConfigFileSource
  | ContentConfigFileSource;

/** Copies the gitignored file at the entry's `path` from the main worktree. */
export interface MainWorktreeConfigFileSource {
  kind: "mainWorktree";
}

/** Copies a committed template from the new worktree's own checkout. */
export interface NewWorktreeConfigFileSource {
  kind: "newWorktree";
  /** Path of the template, relative to the worktree root (e.g. a committed `.example` file). */
  path: string;
}

/** Uses the given content verbatim. The function form may be async. */
export interface ContentConfigFileSource {
  kind: "content";
  content: string | (() => string | Promise<string>);
}

/** Context passed to {@link ConfigFileEntry.patch}. */
export interface PatchContext {
  slot: number;
  ports: Record<string, number>;
  mainWorktree: string;
  currentWorktree: string;
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

  if (command.kind === "guide") {
    printGuide({ runtimeDir: config.runtimeDir, sharedDirs: config.sharedDirs });
    return;
  }

  warnLegacyRegistryDir(config);
  const registryDir = registryDirFor(config.runtimeDir);

  if (command.kind === "migrate") {
    handleMigrate(command, config, registryDir);
    return;
  }

  if (!existsSync(config.scriptPath)) {
    console.error(
      `Error: scriptPath does not exist: ${config.scriptPath}. ` +
        "Pass `fileURLToPath(import.meta.url)` from your wrapper script.",
    );
    process.exit(1);
  }

  switch (command.kind) {
    case "finalize":
      await runFinalize(command, config, registryDir);
      return;
    case "wait":
      await runWait(command, config, registryDir);
      return;
    case "status":
      runStatus(command, config, registryDir);
      return;
    case "list":
      runList(registryDir);
      return;
    case "prune":
      await runPrune(config, registryDir, verbose);
      return;
  }

  const ctx = detectWorktree();
  const run: RunCtx = { verbose };

  switch (command.kind) {
    case "remove":
      await handleRemove(command, ctx, run, config, registryDir);
      return;
    case "setup": {
      const { slot, worktree } = await runSetup(command, ctx, run, config, registryDir);
      if (command.wait) await waitForSlot(slot, config, registryDir, { printSummary: false });
      if (command.go) enterWorktree(worktree);
      return;
    }
  }
}

/**
 * `--go`: open an interactive shell in the freshly set-up worktree (exit to return). Falls back to
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
  config: WorkspaceConfig,
  registryDir: string,
): Promise<{ slot: number; worktree: string }> {
  const scheme: PortScheme = resolvePortScheme(config);
  const portsFn = resolvePortsFn(config);

  validateSlotAvailability(command.slot, {
    currentWorktree: ctx.currentWorktree,
    mainWorktree: ctx.mainWorktree,
    registryDir,
    scheme,
  });

  const setupCtx = ensureWorktree(command, ctx, run, config.worktreeDirName);
  refuseIfFinalizePending(setupCtx, registryDir, command.force);
  const branch = getWorktreeBranch(setupCtx.currentWorktree) ?? "(detached)";
  const { port: slot, status } = resolveAndRegisterSlot({
    slot: command.slot,
    currentWorktree: setupCtx.currentWorktree,
    mainWorktree: setupCtx.mainWorktree,
    registryDir,
    scheme,
    isMainWorktree: setupCtx.isMainWorktree,
    force: command.force,
  });
  const ports = portsFn(slot);

  const logPath = setupLogPath(setupCtx.currentWorktree, config.runtimeDir);
  mkdirSync(dirname(logPath), { recursive: true });
  // Truncate any prior log so `workspace setup` retries start with a clean record (the previous run's
  // FAILED: banner would otherwise linger and produce false positives for grep-based tooling).
  writeFileSync(logPath, "");
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

  verboseLog(
    `Using slot ${slot} (${Object.entries(ports)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ")})`,
  );

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
  await generateConfigFiles(setupCtx, config.configFiles, slot, ports, command.force, verboseLog);

  teeLog(
    config.printSummary({
      slot,
      branch,
      ports,
      currentWorktree: setupCtx.currentWorktree,
      mainWorktree: setupCtx.mainWorktree,
      isMainWorktree: setupCtx.isMainWorktree,
      status,
    }),
  );

  teeLog(`WORKSPACE_CREATED path=${setupCtx.currentWorktree} branch=${branch} slot=${slot}`);
  if (status !== "ready") {
    teeLog(`Setup continuing in background. Tail: ${logPath}`);
    teeLog(`Block until ready: ${waitCommand(setupCtx.currentWorktree, ctx.currentWorktree)}`);
  }

  const finalizeArgs = [config.scriptPath, "__finalize", String(slot)];
  if (command.force) finalizeArgs.push("--force");
  const child = spawn(process.execPath, finalizeArgs, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    cwd: setupCtx.currentWorktree,
  });
  child.unref();
  closeSync(logFd);
  return { slot, worktree: setupCtx.currentWorktree };
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
  const registry = readSlots(ctx.mainWorktree, registryDir);
  const resolvedCurrent = resolve(ctx.currentWorktree);
  const found = Object.entries(registry.slots).find(
    ([, e]) => resolve(e.worktree) === resolvedCurrent && e.status === "pending",
  );
  if (!found) return;
  const [slotPort] = found;
  console.error(
    `Error: Setup is already in progress for slot ${slotPort}. ` +
      `Run \`${wsCmd("wait")}\` to wait for it to finish (or fail), then retry. ` +
      "Use --force to bypass.",
  );
  process.exit(1);
}

type FinalizeCommand = Extract<WorkspaceCommand, { kind: "finalize" }>;

async function runFinalize(
  command: FinalizeCommand,
  config: WorkspaceConfig,
  registryDir: string,
): Promise<void> {
  const slot = Number(command.slot);
  const ctx = detectWorktree();
  const logPath = setupLogPath(ctx.currentWorktree, config.runtimeDir);
  const appendLog = (message: string): void => {
    appendFileSync(logPath, `${message}\n`);
  };

  const registry = readSlots(ctx.mainWorktree, registryDir);
  const entry = registry.slots[String(slot)];
  if (!entry || resolve(entry.worktree) !== resolve(ctx.currentWorktree)) {
    appendLog(`FAILED: No matching slot ${slot} for worktree ${ctx.currentWorktree}.`);
    process.exit(1);
  }

  const branch = getWorktreeBranch(ctx.currentWorktree) ?? "(detached)";

  if (entry.status === "ready" && !command.force) {
    appendLog(`READY: branch ${branch} (slot ${slot}) already finalized; skipping.`);
    return;
  }

  const portsFn = resolvePortsFn(config);
  const ports = portsFn(slot);

  appendLog(`--- finalizing slot ${slot} at ${new Date().toISOString()} ---`);

  const setupContext: SetupContext = {
    currentWorktree: ctx.currentWorktree,
    mainWorktree: ctx.mainWorktree,
    isMainWorktree: ctx.isMainWorktree,
    slot,
    branch,
    ports,
    force: command.force,
    verbose: false,
  };

  try {
    const result = await config.finalizeWorktree(setupContext);
    markSlotReady(ctx.mainWorktree, registryDir, slot, result?.extra);
    appendLog("============================================================");
    appendLog(`READY: branch ${branch} (slot ${slot})`);
    appendLog("============================================================");
  } catch (err) {
    const message = (err as Error).message;
    const stack = (err as Error).stack ?? "";
    markSlotFailed(ctx.mainWorktree, registryDir, slot, message);
    appendLog(`FAILED: ${message}`);
    if (stack) appendLog(stack);
    process.exit(1);
  }
}

/** The single workspace a `status`/`wait`/`remove` selector points at. */
interface ResolvedTarget {
  slot: number;
  worktree: string;
}

function resolveTarget(
  selector: WorkspaceSelector,
  ctx: WorktreeContext,
  config: WorkspaceConfig,
  registryDir: string,
): ResolvedTarget {
  const { slot, dir } = selector;
  if (slot !== undefined || dir !== undefined) {
    const registry = readSlots(ctx.mainWorktree, registryDir);
    if (slot !== undefined) return targetFromSlot(slot, registry, config, ctx.mainWorktree);
    if (dir !== undefined) return targetFromDir(dir, registry);
  }
  const resolved = resolveCurrentSlot(config.basePort, registryDir);
  return { slot: resolved.slot, worktree: resolved.worktree };
}

function targetFromSlot(
  slotArg: string,
  registry: SlotsRegistry,
  config: WorkspaceConfig,
  mainWorktree: string,
): ResolvedTarget {
  const scheme = resolvePortScheme(config);
  const slot = Number(slotArg);
  // The main worktree's reserved base port is a selectable slot even though it is not an assignable
  // sibling slot, so accept it here alongside the stepped sibling range.
  if (!isValidPort(slot, scheme) && !isReservedMainSlot(slot, scheme)) {
    console.error(
      `Error: --slot expects ${scheme.basePort} (main worktree) or a port in [${scheme.minPort}, ${scheme.maxPort}] stepped by ${scheme.portStep}; got "${slotArg}".`,
    );
    process.exit(1);
  }
  // The main worktree is never recorded in the slots registry, so map its reserved slot straight to
  // the known main worktree path — mirroring how the no-arg current-worktree path synthesizes it.
  if (isReservedMainSlot(slot, scheme)) {
    return { slot, worktree: mainWorktree };
  }
  const entry = registry.slots[String(slot)];
  if (!entry) {
    console.error(`Error: No slot ${slot} in registry.`);
    process.exit(1);
  }
  return { slot, worktree: entry.worktree };
}

function targetFromDir(dir: string, registry: SlotsRegistry): ResolvedTarget {
  const port = matchWorktreeByDir(dir, registry, process.cwd());
  if (port === undefined) {
    console.error(
      `Error: No workspace matching "${dir}" (by path or directory name). Run \`${wsCmd("list")}\`.`,
    );
    process.exit(1);
  }
  const entry = registry.slots[port];
  return { slot: Number(port), worktree: entry.worktree };
}

/** Matches `dir` against the registry: first as a path (resolved against `cwd`), then by basename. */
export function matchWorktreeByDir(
  dir: string,
  registry: SlotsRegistry,
  cwd: string,
): string | undefined {
  const resolvedPath = resolve(cwd, dir);
  for (const [port, entry] of Object.entries(registry.slots)) {
    if (resolve(entry.worktree) === resolvedPath) return port;
  }
  for (const [port, entry] of Object.entries(registry.slots)) {
    if (basename(entry.worktree) === dir) return port;
  }
  return undefined;
}

function printWorktreeInfo(
  config: WorkspaceConfig,
  registryDir: string,
  slot: number,
  worktreeForLog: string,
): void {
  const ctx = detectWorktree();
  const registry = readSlots(ctx.mainWorktree, registryDir);
  const entry: SlotEntry | undefined = registry.slots[String(slot)];
  const ports = resolvePortsFn(config)(slot);

  const status: SlotStatus = entry?.status ?? "pending";
  const setupLog = setupLogPath(worktreeForLog, config.runtimeDir);
  const now = Date.now();
  const isMainWorktree = entry?.main ?? false;
  const targetWorktree = entry?.worktree ?? ctx.currentWorktree;
  const branch = getWorktreeBranch(targetWorktree) ?? "(detached)";
  console.log(
    config.printSummary({
      slot,
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
    console.log(`Pending since ${elapsed} ago (tail ${setupLogPath})`);
  }
  printDevServerBlock(config, registryDir, ctx.mainWorktree, targetWorktree, now);
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

function runStatus(command: StatusCommand, config: WorkspaceConfig, registryDir: string): void {
  const ctx = detectWorktree();
  const target = resolveTarget(command.selector, ctx, config, registryDir);
  printWorktreeInfo(config, registryDir, target.slot, target.worktree);
}

function runList(registryDir: string): void {
  const ctx = detectWorktree();
  const liveOrphans = autoPruneSafeOrphans(ctx.mainWorktree, registryDir);
  const entries = Object.entries(readSlots(ctx.mainWorktree, registryDir).slots).sort(
    ([a], [b]) => Number(a) - Number(b),
  );
  if (entries.length === 0) {
    console.log("No workspaces registered.");
    hintLiveOrphans(liveOrphans);
    return;
  }
  const liveSet = liveWorktrees(readDevServers(ctx.mainWorktree, registryDir));
  const rows = entries.map(([port, e]) => ({
    slot: port,
    type: e.main ? "main" : "linked",
    status: e.status,
    dev: liveSet.has(resolve(e.worktree)) ? "up" : "-",
    branch: getWorktreeBranch(e.worktree) ?? "(detached)",
    worktree: e.worktree,
    created: e.createdAt,
  }));
  const headers = {
    slot: "SLOT",
    type: "TYPE",
    status: "STATUS",
    dev: "DEV",
    branch: "BRANCH",
    worktree: "PATH",
    created: "CREATED",
  };
  const widths = {
    slot: Math.max(headers.slot.length, ...rows.map((r) => r.slot.length)),
    type: Math.max(headers.type.length, ...rows.map((r) => r.type.length)),
    status: Math.max(headers.status.length, ...rows.map((r) => r.status.length)),
    dev: Math.max(headers.dev.length, ...rows.map((r) => r.dev.length)),
    branch: Math.max(headers.branch.length, ...rows.map((r) => r.branch.length)),
    worktree: Math.max(headers.worktree.length, ...rows.map((r) => r.worktree.length)),
  };
  const fmt = (r: typeof headers): string =>
    `${r.slot.padEnd(widths.slot)}  ${r.type.padEnd(widths.type)}  ${r.status.padEnd(widths.status)}  ${r.dev.padEnd(widths.dev)}  ${r.branch.padEnd(widths.branch)}  ${r.worktree.padEnd(widths.worktree)}  ${r.created}`;
  console.log(fmt(headers));
  for (const r of rows) console.log(fmt(r));
  hintLiveOrphans(liveOrphans);
}

/**
 * Silently drop registry entries for worktrees deleted out-of-band that have no live dev-server —
 * harmless bookkeeping, consistent with the existing dead-PID pruning. Orphans whose dev-server is
 * still running are left untouched (stopping a live process is the explicit `workspace prune`'s job)
 * and returned so the caller can hint about them.
 */
function autoPruneSafeOrphans(mainWorktree: string, registryDir: string): string[] {
  const registry = readSlots(mainWorktree, registryDir);
  const orphanPorts = findOrphanPorts(registry);
  if (orphanPorts.length === 0) return [];
  const live = liveWorktrees(readDevServers(mainWorktree, registryDir));
  const liveOrphans: string[] = [];
  let changed = false;
  for (const port of orphanPorts) {
    const entry = registry.slots[port];
    if (live.has(resolve(entry.worktree))) {
      liveOrphans.push(port);
      continue;
    }
    delete registry.slots[port];
    removeDevServerEntryByWorktree(mainWorktree, registryDir, entry.worktree);
    changed = true;
  }
  if (changed) writeSlots(mainWorktree, registryDir, registry);
  return liveOrphans;
}

function hintLiveOrphans(liveOrphans: string[]): void {
  if (liveOrphans.length === 0) return;
  console.log(
    `\nNote: ${liveOrphans.length} workspace(s) have a deleted worktree but a still-running ` +
      `dev-server. Run \`${wsCmd("prune")}\` to stop them and clean up.`,
  );
}

async function runPrune(
  config: WorkspaceConfig,
  registryDir: string,
  verbose: boolean,
): Promise<void> {
  const ctx = detectWorktree();
  const registry = readSlots(ctx.mainWorktree, registryDir);
  const orphanPorts = findOrphanPorts(registry);

  let stoppedProcesses = 0;
  for (const port of orphanPorts) {
    const entry = registry.slots[port];
    stoppedProcesses += await stopOrphanedDevServer(ctx.mainWorktree, registryDir, entry.worktree);
    await runPurgeInfrastructure(config, {
      worktree: entry.worktree,
      mainWorktree: ctx.mainWorktree,
      slot: Number(port),
      extra: entry.extra,
      verbose,
    });
    delete registry.slots[port];
    console.log(`Pruned slot ${port} (${entry.worktree}).`);
  }

  if (orphanPorts.length > 0) writeSlots(ctx.mainWorktree, registryDir, registry);
  pruneGitWorktrees(ctx.mainWorktree);

  if (orphanPorts.length === 0) {
    console.log("No orphaned workspaces to prune.");
    return;
  }
  console.log(`Pruned ${orphanPorts.length} orphaned workspace(s).`);
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
 * `purgeInfrastructure` (by name, from the slot's `extra`) to tear down callback-managed infra.
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

async function runWait(
  command: WaitCommand,
  config: WorkspaceConfig,
  registryDir: string,
): Promise<void> {
  // standalone `workspace wait` (no prior setup in this invocation) → print the full summary on success.
  const ctx = detectWorktree();
  const target = resolveTarget(command.selector, ctx, config, registryDir);
  await waitForSlot(target.slot, config, registryDir);
}

async function waitForSlot(
  slot: number,
  config: WorkspaceConfig,
  registryDir: string,
  options: { printSummary?: boolean } = {},
): Promise<void> {
  const printSummary = options.printSummary ?? true;
  const ctx = detectWorktree();
  const initial = readSlots(ctx.mainWorktree, registryDir).slots[String(slot)];
  if (!initial) {
    console.error(`Error: No slot ${slot} in registry.`);
    process.exit(1);
  }

  const pollMs = 500;
  // Poll slots.json — the finalize child writes `status` on success or failure. Tiny file, no
  // log-tailing race.
  for (;;) {
    const entry = readSlots(ctx.mainWorktree, registryDir).slots[String(slot)];
    if (!entry) {
      console.error(`Error: Slot ${slot} disappeared from registry.`);
      process.exit(1);
    }
    if (entry.status === "ready") {
      console.log("\n… ready");
      if (printSummary) {
        printWorktreeInfo(config, registryDir, slot, entry.worktree);
      }
      return;
    }
    if (entry.status === "failed") {
      const logPath = setupLogPath(entry.worktree, config.runtimeDir);
      console.error(`FAILED: ${entry.failure?.message ?? "(no message)"}`);
      console.error(`Full log: ${logPath}`);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

type RemoveCommand = Extract<WorkspaceCommand, { kind: "remove" }>;

async function handleRemove(
  command: RemoveCommand,
  ctx: WorktreeContext,
  run: RunCtx,
  config: WorkspaceConfig,
  registryDir: string,
): Promise<void> {
  const verboseLog = makeVerboseLog(run.verbose);
  const registry = readSlots(ctx.mainWorktree, registryDir);
  const target = resolveTarget(command.selector, ctx, config, registryDir);
  const slotPort = String(target.slot);
  const worktree = target.worktree;
  if (resolve(worktree) === resolve(ctx.mainWorktree)) {
    console.error("Error: Cannot remove the main worktree.");
    process.exit(1);
  }
  const removeHere = resolve(worktree) === resolve(ctx.currentWorktree);
  const branch = getWorktreeBranch(worktree) ?? "(detached)";

  // Refuse to remove while the detached finalize is still writing to slots.json / workspace-setup.log:
  // racing the two corrupts the registry and leaves the worktree directory orphaned.
  if (registry.slots[slotPort]?.status === "pending") {
    console.error(
      `Error: Setup is still in progress for slot ${slotPort}. ` +
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
      slot: target.slot,
      extra: registry.slots[slotPort]?.extra,
      verbose: run.verbose,
    });
    delete registry.slots[slotPort];
    writeSlots(ctx.mainWorktree, registryDir, registry);
    pruneGitWorktrees(ctx.mainWorktree);
    console.log(`Removed registry entry for branch "${branch}" (slot ${slotPort}).`);
    return;
  }

  if (!command.force && isWorktreeDirty(worktree)) {
    console.error(
      `Error: Uncommitted changes in ${worktree}. Commit or stash them, or pass --force.`,
    );
    process.exit(1);
  }

  const targetEntry = findOwnEntry(ctx.mainWorktree, registryDir, worktree);
  if (targetEntry) {
    stopTargetDevServer(config.devServerScript, worktree, verboseLog);
  } else {
    verboseLog(`No dev-server running in ${worktree}; skipping stop.`);
  }

  await runPurgeInfrastructure(config, {
    worktree,
    mainWorktree: ctx.mainWorktree,
    slot: target.slot,
    extra: registry.slots[slotPort]?.extra,
    verbose: run.verbose,
  });

  delete registry.slots[slotPort];
  writeSlots(ctx.mainWorktree, registryDir, registry);
  removeDevServerEntryByWorktree(ctx.mainWorktree, registryDir, worktree);

  if (removeHere) process.chdir(ctx.mainWorktree);

  removeWorktree(worktree, run);

  console.log(
    `Removed workspace for branch "${branch}" (slot ${slotPort}). Branch "${branch}" kept.`,
  );
  if (removeHere) console.log(`Now run: cd ${ctx.mainWorktree}`);
}

async function runPurgeInfrastructure(config: WorkspaceConfig, ctx: PurgeContext): Promise<void> {
  if (config.purgeInfrastructure) await config.purgeInfrastructure(ctx);
}

type MigrateCommand = Extract<WorkspaceCommand, { kind: "migrate" }>;

/** Transitional (0.16 only): merge a pre-0.16 registry into `${runtimeDir}/workspace-registry`. */
function handleMigrate(command: MigrateCommand, config: WorkspaceConfig, newRel: string): void {
  const ctx = detectWorktree();
  const oldRel = command.oldRegistryDir;
  const oldAbs = join(ctx.mainWorktree, oldRel);

  if (resolve(oldAbs) === resolve(join(ctx.mainWorktree, newRel))) {
    console.log(`Registry already at ${newRel}; relinking worktrees.`);
    relinkWorktrees(readSlots(ctx.mainWorktree, newRel), ctx.mainWorktree, config.runtimeDir);
    return;
  }
  refuseUnlessOldRegistry(oldAbs, ctx.mainWorktree);

  const mergedSlots = mergeSlots(
    readSlots(ctx.mainWorktree, oldRel),
    readSlots(ctx.mainWorktree, newRel),
  );
  writeSlots(ctx.mainWorktree, newRel, mergedSlots);
  const mergedDevServers = mergeDevServers(
    readDevServers(ctx.mainWorktree, oldRel),
    readDevServers(ctx.mainWorktree, newRel),
  );
  writeDevServers(ctx.mainWorktree, newRel, mergedDevServers);
  rmSync(oldAbs, { recursive: true, force: true });

  const relinked = relinkWorktrees(mergedSlots, ctx.mainWorktree, config.runtimeDir);
  console.log(
    `Migrated ${oldRel} → ${newRel}: ${Object.keys(mergedSlots.slots).length} slot(s), ` +
      `${mergedDevServers.servers.length} dev-server(s); ${relinked} symlink(s) recreated.`,
  );
}

/** `oldAbs` is recursively deleted after the merge — refuse anything that isn't clearly a registry. */
function refuseUnlessOldRegistry(oldAbs: string, mainWorktree: string): void {
  const fromMain = relative(mainWorktree, resolve(oldAbs));
  if (fromMain.startsWith("..") || isAbsolute(fromMain)) {
    console.error(`Error: the old registry must be inside the main worktree; got ${oldAbs}.`);
    process.exit(1);
  }
  if (!existsSync(oldAbs)) {
    console.error(`Error: nothing to migrate at ${oldAbs}.`);
    process.exit(1);
  }
  if (!existsSync(join(oldAbs, "slots.json")) && !existsSync(join(oldAbs, "dev-servers.json"))) {
    console.error(
      `Error: ${oldAbs} does not look like a registry (no slots.json or dev-servers.json).`,
    );
    process.exit(1);
  }
}

function relinkWorktrees(slots: SlotsRegistry, mainWorktree: string, runtimeDir: string): number {
  let count = 0;
  for (const entry of Object.values(slots.slots)) {
    if (entry.main) continue;
    if (!existsSync(entry.worktree)) {
      console.warn(`Warning: worktree ${entry.worktree} not found; skipping symlink.`);
      continue;
    }
    linkWorkspaceRegistry(
      { currentWorktree: entry.worktree, mainWorktree, isMainWorktree: false },
      runtimeDir,
      console.log,
      { force: true },
    );
    ++count;
  }
  return count;
}

function ensureWorktree(
  command: SetupCommand,
  ctx: WorktreeContext,
  run: RunCtx,
  dirNameFn: WorktreeDirNameFn | undefined,
): WorktreeContext {
  if (command.branch === undefined) return ctx;
  if (command.newBranch) return createBranch(command.branch, ctx, run, dirNameFn, command.from);
  return useExistingBranch(command.branch, ctx, run, dirNameFn);
}

function linkSharedDirectories(
  ctx: WorktreeContext,
  dirs: string[],
  log: (msg: string) => void,
): void {
  for (const dirName of dirs) {
    const link = join(ctx.currentWorktree, dirName);
    const mainDir = join(ctx.mainWorktree, dirName);
    if (!existsSync(mainDir)) {
      log(`Skipped ${dirName} symlink (not present in main worktree).`);
    } else if (existsSync(link)) {
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
 * cwd-relative registry read in `resolveCurrentSlot` reaches main. `runtimeDir` is per-worktree and
 * not in `sharedDirs`, so this is distinct from {@link linkSharedDirectories}.
 */
function linkWorkspaceRegistry(
  ctx: WorktreeContext,
  runtimeDir: string,
  log: (msg: string) => void,
  opts?: { force?: boolean },
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
    if (!opts?.force && existsSync(link)) {
      log("Skipped workspace-registry symlink (already exists).");
      return;
    }
    rmSync(link);
  }
  symlinkSync(relative(runtimeRoot, mainDir), link);
  log("Created workspace-registry symlink → main worktree.");
}

async function generateConfigFiles(
  ctx: WorktreeContext,
  entries: ConfigFileEntry[],
  slot: number,
  ports: Record<string, number>,
  force: boolean,
  log: (msg: string) => void,
): Promise<void> {
  for (const entry of entries) {
    const patchCtx: PatchContext = {
      slot,
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
      await resolveConfigSource(entry, patchCtx),
      patchFn,
      entry.path,
      force,
      entry.optional ?? false,
    );
  }
}

export async function resolveConfigSource(
  entry: ConfigFileEntry,
  ctx: PatchContext,
): Promise<ResolvedFileSource> {
  const { source } = entry;
  switch (source.kind) {
    case "mainWorktree":
      return { path: join(ctx.mainWorktree, entry.path) };
    case "newWorktree":
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

function resolvePortsFn(config: WorkspaceConfig): (slot: number) => Record<string, number> {
  if (config.ports) return config.ports;
  if (config.portNames && config.portNames.length > 0) {
    return defaultComputePorts(config.portNames);
  }
  throw new ConfigError("Config error: provide either `ports` (function) or `portNames` (array).");
}

function makeVerboseLog(verbose: boolean): (msg: string) => void {
  return (msg) => {
    if (verbose) console.log(msg);
  };
}
