import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { parseWorkspaceArgs, printWorkspaceHelp, type WorkspaceCommand } from "./cli.js";
import {
  findOwnEntry,
  liveWorktrees,
  readDevServers,
  removeDevServerEntryByWorktree,
} from "./dev-servers-registry.js";
import { ConfigError } from "./errors.js";
import {
  copyAndPatchFile,
  formatDuration,
  type ResolvedFileSource,
  setupLogPath,
} from "./helpers.js";
import { isProcessAlive } from "./process-control.js";
import { defaultComputePorts, isValidPort, resolvePortScheme, type PortScheme } from "./ports.js";
import {
  handleSetOwner,
  markSlotFailed,
  markSlotReady,
  readSlots,
  resolveAndRegisterSlot,
  resolveCurrentSlot,
  type SlotEntry,
  type SlotStatus,
  validateSlotAvailability,
  writeSlots,
} from "./slots.js";
import {
  createBranch,
  detectWorktree,
  enforceWorktreeMode,
  getWorktreeBranch,
  removeWorktree,
  type RunCtx,
  useExistingBranch,
  verifyBranchAbsentFromRemote,
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
  /**
   * Shared registry directory, relative to a worktree root (e.g. `.local/_workspace-registry`).
   * Holds `slots.json` and `dev-servers.json`. Must resolve to the same physical directory
   * across linked worktrees — typically via a symlink listed in `sharedDirs` (e.g. `.local`).
   */
  registryDir: string;
  /** Config files copied from the main worktree and patched per slot. */
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
   */
  finalizeWorktree: (ctx: SetupContext) => Promise<void> | void;
  /**
   * Destructive infrastructure teardown on `workspace remove` (e.g. `docker compose down -v` to
   * wipe volumes). Runs after the dev-server stop. Best-effort; errors should be swallowed.
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

/** Context passed to {@link WorkspaceConfig.finalizeWorktree}. */
export interface SetupContext {
  currentWorktree: string;
  mainWorktree: string;
  /** `true` when finalizing the main worktree. Gate "copy from main" steps with `!isMainWorktree`. */
  isMainWorktree: boolean;
  slot: number;
  /** Live-resolved branch of `currentWorktree`. `"(detached)"` for detached HEAD. */
  branch: string;
  owner?: string;
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
  owner?: string;
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
  worktree: string;
  mainWorktree: string;
  verbose: boolean;
}

/** A `{ path }` (relative to the main worktree) or `{ content }` (verbatim) initial source. */
export type ConfigFileSourceSpec = { path: string } | { content: string };

/**
 * Overrides where a {@link ConfigFileEntry}'s initial content comes from. Defaults to reading
 * `entry.path` from the main worktree.
 *
 * - `{ path }` — read this path (relative to the main worktree) instead of `entry.path`,
 *   e.g. seed from a committed example: `{ path: "packages/api/.env.local.example" }`.
 * - `{ content }` — use this string as the initial content verbatim.
 * - a callback returning either of the above, resolved per worktree with the same
 *   {@link PatchContext} the `patch` callback receives.
 */
export type ConfigFileSource = ConfigFileSourceSpec | ((ctx: PatchContext) => ConfigFileSourceSpec);

/** One config file copied from the main worktree and patched per slot. */
export interface ConfigFileEntry {
  /** Path relative to the worktree root. Written to the current worktree. */
  path: string;
  /**
   * Overrides the initial content's source. Defaults to reading `path` from the main worktree.
   * Use this to seed from a committed example or supplied content instead. See {@link ConfigFileSource}.
   */
  source?: ConfigFileSource;
  /** Returns the patched content given the source content and the slot's ports. */
  patch: (content: string, ctx: PatchContext) => string;
  /**
   * When `true`, a missing `{ path }` source logs a warning and skips the entry.
   * Default: required (missing source aborts setup). Bootstrap the main worktree first via
   * `workspace setup`, or seed sources in `preSetup`. Ignored for `{ content }` sources.
   */
  optional?: boolean;
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

  if (!existsSync(config.scriptPath)) {
    console.error(
      `Error: scriptPath does not exist: ${config.scriptPath}. ` +
        "Pass `fileURLToPath(import.meta.url)` from your wrapper script.",
    );
    process.exit(1);
  }

  switch (command.kind) {
    case "finalize":
      await runFinalize(command, config);
      return;
    case "wait":
      await runWait(command, config);
      return;
    case "status":
      runStatus(command, config);
      return;
    case "list":
      runList(config);
      return;
  }

  const ctx = detectWorktree();
  enforceWorktreeMode(command, ctx);
  const run: RunCtx = { verbose };

  switch (command.kind) {
    case "remove":
      await handleRemove(command, ctx, run, config);
      return;
    case "set-owner":
      handleSetOwnerMode(command, ctx, config);
      return;
    case "setup": {
      const { slot } = await runSetup(command, ctx, run, config);
      if (command.wait) await waitForSlot(slot, config, { printSummary: false });
      return;
    }
  }
}

type SetupCommand = Extract<WorkspaceCommand, { kind: "setup" }>;

async function runSetup(
  command: SetupCommand,
  ctx: WorktreeContext,
  run: RunCtx,
  config: WorkspaceConfig,
): Promise<{ slot: number }> {
  const scheme: PortScheme = resolvePortScheme(config);
  const portsFn = resolvePortsFn(config);

  validateSlotAvailability(command.slot, {
    currentWorktree: ctx.currentWorktree,
    mainWorktree: ctx.mainWorktree,
    registryDir: config.registryDir,
    scheme,
  });

  const setupCtx = ensureWorktree(command, ctx, run, config.worktreeDirName);
  refuseIfFinalizePending(setupCtx, config.registryDir, command.force);
  const branch = getWorktreeBranch(setupCtx.currentWorktree) ?? "(detached)";
  const {
    port: slot,
    owner,
    status,
  } = resolveAndRegisterSlot({
    slot: command.slot,
    currentWorktree: setupCtx.currentWorktree,
    mainWorktree: setupCtx.mainWorktree,
    registryDir: config.registryDir,
    scheme,
    requestedOwner: command.owner,
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
  generateConfigFiles(setupCtx, config.configFiles, slot, ports, command.force, verboseLog);

  teeLog(
    config.printSummary({
      slot,
      branch,
      owner,
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
    teeLog(`Block until ready: workspace wait --slot ${slot}`);
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
  return { slot };
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
      `Run 'workspace wait --slot ${slotPort}' to wait for it to finish (or fail), ` +
      "then retry. Use --force to bypass.",
  );
  process.exit(1);
}

type FinalizeCommand = Extract<WorkspaceCommand, { kind: "finalize" }>;

async function runFinalize(command: FinalizeCommand, config: WorkspaceConfig): Promise<void> {
  const slot = Number(command.slot);
  const ctx = detectWorktree();
  const logPath = setupLogPath(ctx.currentWorktree, config.runtimeDir);
  const appendLog = (message: string): void => {
    appendFileSync(logPath, `${message}\n`);
  };

  const registry = readSlots(ctx.mainWorktree, config.registryDir);
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
    owner: entry.owner,
    ports,
    force: command.force,
    verbose: false,
  };

  try {
    await config.finalizeWorktree(setupContext);
    markSlotReady(ctx.mainWorktree, config.registryDir, slot);
    appendLog("============================================================");
    appendLog(`READY: branch ${branch} (slot ${slot})`);
    appendLog("============================================================");
  } catch (err) {
    const message = (err as Error).message;
    const stack = (err as Error).stack ?? "";
    markSlotFailed(ctx.mainWorktree, config.registryDir, slot, message);
    appendLog(`FAILED: ${message}`);
    if (stack) appendLog(stack);
    process.exit(1);
  }
}

function resolveTargetSlot(slotArg: string | undefined, config: WorkspaceConfig): number {
  if (slotArg !== undefined) {
    const slot = Number(slotArg);
    const scheme = resolvePortScheme(config);
    if (!isValidPort(slot, scheme)) {
      console.error(
        `Error: --slot expects a port in [${scheme.minPort}, ${scheme.maxPort}] stepped by ${scheme.portStep}; got "${slotArg}".`,
      );
      process.exit(1);
    }
    return slot;
  }
  return resolveCurrentSlot(config.basePort, config.registryDir).slot;
}

function printWorktreeInfo(
  config: WorkspaceConfig,
  slot: number,
  worktreeForLog: string,
  fallback: { owner?: string },
): void {
  const ctx = detectWorktree();
  const registry = readSlots(ctx.mainWorktree, config.registryDir);
  const entry: SlotEntry | undefined = registry.slots[String(slot)];
  const ports = resolvePortsFn(config)(slot);

  const owner = entry?.owner ?? fallback.owner;
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
      owner,
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
  printDevServerBlock(config, ctx.mainWorktree, targetWorktree, now);
}

function printDevServerBlock(
  config: WorkspaceConfig,
  mainWorktree: string,
  targetWorktree: string,
  now: number,
): void {
  const entry = findOwnEntry(mainWorktree, config.registryDir, targetWorktree);
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

function runStatus(command: StatusCommand, config: WorkspaceConfig): void {
  if (command.slot !== undefined) {
    const slot = resolveTargetSlot(command.slot, config);
    const ctx = detectWorktree();
    const entry = readSlots(ctx.mainWorktree, config.registryDir).slots[String(slot)];
    if (!entry) {
      console.error(`Error: No slot ${slot} in registry.`);
      process.exit(1);
    }
    printWorktreeInfo(config, slot, entry.worktree, { owner: entry.owner });
    return;
  }
  const resolved = resolveCurrentSlot(config.basePort, config.registryDir);
  printWorktreeInfo(config, resolved.slot, resolved.worktree, {
    owner: resolved.owner,
  });
}

function runList(config: WorkspaceConfig): void {
  const ctx = detectWorktree();
  const entries = Object.entries(readSlots(ctx.mainWorktree, config.registryDir).slots).sort(
    ([a], [b]) => Number(a) - Number(b),
  );
  if (entries.length === 0) {
    console.log("No workspaces registered.");
    return;
  }
  const liveSet = liveWorktrees(readDevServers(ctx.mainWorktree, config.registryDir));
  const rows = entries.map(([port, e]) => ({
    slot: port,
    type: e.main ? "main" : "linked",
    status: e.status,
    dev: liveSet.has(resolve(e.worktree)) ? "up" : "-",
    branch: getWorktreeBranch(e.worktree) ?? "(detached)",
    worktree: e.worktree,
    owner: e.owner ?? "-",
    created: e.createdAt,
  }));
  const headers = {
    slot: "SLOT",
    type: "TYPE",
    status: "STATUS",
    dev: "DEV",
    branch: "BRANCH",
    worktree: "PATH",
    owner: "OWNER",
    created: "CREATED",
  };
  const widths = {
    slot: Math.max(headers.slot.length, ...rows.map((r) => r.slot.length)),
    type: Math.max(headers.type.length, ...rows.map((r) => r.type.length)),
    status: Math.max(headers.status.length, ...rows.map((r) => r.status.length)),
    dev: Math.max(headers.dev.length, ...rows.map((r) => r.dev.length)),
    branch: Math.max(headers.branch.length, ...rows.map((r) => r.branch.length)),
    worktree: Math.max(headers.worktree.length, ...rows.map((r) => r.worktree.length)),
    owner: Math.max(headers.owner.length, ...rows.map((r) => r.owner.length)),
  };
  const fmt = (r: typeof headers): string =>
    `${r.slot.padEnd(widths.slot)}  ${r.type.padEnd(widths.type)}  ${r.status.padEnd(widths.status)}  ${r.dev.padEnd(widths.dev)}  ${r.branch.padEnd(widths.branch)}  ${r.worktree.padEnd(widths.worktree)}  ${r.owner.padEnd(widths.owner)}  ${r.created}`;
  console.log(fmt(headers));
  for (const r of rows) console.log(fmt(r));
}

type WaitCommand = Extract<WorkspaceCommand, { kind: "wait" }>;

async function runWait(command: WaitCommand, config: WorkspaceConfig): Promise<void> {
  // standalone `workspace wait` (no prior setup in this invocation) → print the full summary on success.
  const slot = resolveTargetSlot(command.slot, config);
  await waitForSlot(slot, config);
}

async function waitForSlot(
  slot: number,
  config: WorkspaceConfig,
  options: { printSummary?: boolean } = {},
): Promise<void> {
  const printSummary = options.printSummary ?? true;
  const ctx = detectWorktree();
  const initial = readSlots(ctx.mainWorktree, config.registryDir).slots[String(slot)];
  if (!initial) {
    console.error(`Error: No slot ${slot} in registry.`);
    process.exit(1);
  }

  const pollMs = 500;
  // Poll slots.json — the finalize child writes `status` on success or failure. Tiny file, no
  // log-tailing race.
  for (;;) {
    const entry = readSlots(ctx.mainWorktree, config.registryDir).slots[String(slot)];
    if (!entry) {
      console.error(`Error: Slot ${slot} disappeared from registry.`);
      process.exit(1);
    }
    if (entry.status === "ready") {
      console.log("\n… ready");
      if (printSummary) {
        printWorktreeInfo(config, slot, entry.worktree, {
          owner: entry.owner,
        });
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
): Promise<void> {
  const verboseLog = makeVerboseLog(run.verbose);
  const removeHere = command.branch === undefined;
  const registry = readSlots(ctx.mainWorktree, config.registryDir);
  const target = resolveRemoveTarget(command, ctx, registry);

  // Refuse to remove while the detached finalize is still writing to slots.json / workspace-setup.log:
  // racing the two corrupts the registry and leaves the worktree directory orphaned.
  if (registry.slots[target.slotPort]?.status === "pending") {
    console.error(
      `Error: Setup is still in progress for slot ${target.slotPort}. ` +
        `Run 'workspace wait --slot ${target.slotPort}' to wait for it to finish (or fail), then retry the removal.`,
    );
    process.exit(1);
  }

  if (!command.noRemoteCheck) {
    verifyBranchAbsentFromRemote(target.branch, run);
  }

  const ownerSuffix = target.owner ? `, owner ${target.owner}` : "";

  if (!existsSync(target.worktreePath)) {
    console.warn(
      `Warning: Worktree directory ${target.worktreePath} not found. Cleaning up registry only.`,
    );
    delete registry.slots[target.slotPort];
    writeSlots(ctx.mainWorktree, config.registryDir, registry);
    console.log(
      `Removed registry entry for branch "${target.branch}" (slot ${target.slotPort}${ownerSuffix}).`,
    );
    return;
  }

  const targetEntry = findOwnEntry(ctx.mainWorktree, config.registryDir, target.worktreePath);
  if (targetEntry) {
    stopTargetDevServer(config.devServerScript, target.worktreePath, verboseLog);
  } else {
    verboseLog(`No dev-server running in ${target.worktreePath}; skipping stop.`);
  }

  if (config.purgeInfrastructure) {
    await config.purgeInfrastructure({
      worktree: target.worktreePath,
      mainWorktree: ctx.mainWorktree,
      verbose: run.verbose,
    });
  }

  delete registry.slots[target.slotPort];
  writeSlots(ctx.mainWorktree, config.registryDir, registry);
  removeDevServerEntryByWorktree(ctx.mainWorktree, config.registryDir, target.worktreePath);

  if (removeHere) {
    process.chdir(ctx.mainWorktree);
  }

  removeWorktree(target.worktreePath, run);

  console.log(
    `Removed workspace for branch "${target.branch}" (slot ${target.slotPort}${ownerSuffix}). ` +
      `Branch "${target.branch}" kept.`,
  );
  if (removeHere) {
    console.log(`Now run: cd ${ctx.mainWorktree}`);
  }
}

type SetOwnerCommand = Extract<WorkspaceCommand, { kind: "set-owner" }>;

function handleSetOwnerMode(
  command: SetOwnerCommand,
  ctx: WorktreeContext,
  config: WorkspaceConfig,
): void {
  const newOwner = command.name;
  const { slotPort } = handleSetOwner({
    newOwner,
    currentWorktree: ctx.currentWorktree,
    mainWorktree: ctx.mainWorktree,
    registryDir: config.registryDir,
    isMainWorktree: ctx.isMainWorktree,
  });

  // Propagate to dev-servers.json entries for this worktree.
  const devServersPath = join(ctx.mainWorktree, config.registryDir, "dev-servers.json");
  if (existsSync(devServersPath)) {
    const data = JSON.parse(readFileSync(devServersPath, "utf-8")) as {
      servers: { worktree: string; owner?: string }[];
    };
    let changed = false;
    const resolvedCurrent = resolve(ctx.currentWorktree);
    for (const server of data.servers) {
      if (resolve(server.worktree) === resolvedCurrent) {
        if (newOwner !== undefined) server.owner = newOwner;
        else delete server.owner;
        changed = true;
      }
    }
    if (changed) {
      mkdirSync(dirname(devServersPath), { recursive: true });
      writeFileSync(devServersPath, `${JSON.stringify(data, undefined, 2)}\n`);
    }
  }

  console.log(`Owner for slot ${slotPort}: ${newOwner ?? "(none)"}`);
}

function ensureWorktree(
  command: SetupCommand,
  ctx: WorktreeContext,
  run: RunCtx,
  dirNameFn: WorktreeDirNameFn | undefined,
): WorktreeContext {
  if (command.branch === undefined) return ctx;
  if (command.newBranch) return createBranch(command.branch, ctx, run, dirNameFn);
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

function generateConfigFiles(
  ctx: WorktreeContext,
  entries: ConfigFileEntry[],
  slot: number,
  ports: Record<string, number>,
  force: boolean,
  log: (msg: string) => void,
): void {
  for (const entry of entries) {
    const patchCtx: PatchContext = {
      slot,
      ports,
      mainWorktree: ctx.mainWorktree,
      currentWorktree: ctx.currentWorktree,
    };
    copyAndPatchFile(
      { currentWorktree: ctx.currentWorktree, log },
      entry.path,
      resolveConfigSource(entry, patchCtx),
      (content) => entry.patch(content, patchCtx),
      entry.path,
      force,
      entry.optional ?? false,
    );
  }
}

function resolveConfigSource(entry: ConfigFileEntry, ctx: PatchContext): ResolvedFileSource {
  const spec = typeof entry.source === "function" ? entry.source(ctx) : entry.source;
  if (spec === undefined) return { path: join(ctx.mainWorktree, entry.path) };
  if ("content" in spec) return { content: spec.content };
  return { path: join(ctx.mainWorktree, spec.path) };
}

interface RemoveTarget {
  slotPort: string;
  branch: string;
  worktreePath: string;
  owner?: string;
}

function resolveRemoveTarget(
  command: RemoveCommand,
  ctx: WorktreeContext,
  registry: ReturnType<typeof readSlots>,
): RemoveTarget {
  if (command.branch === undefined) {
    if (ctx.isMainWorktree) {
      console.error("Error: Cannot remove the main worktree.");
      process.exit(1);
    }
    const resolvedCurrent = resolve(ctx.currentWorktree);
    const entry = Object.entries(registry.slots).find(
      ([, v]) => resolve(v.worktree) === resolvedCurrent,
    );
    if (!entry) {
      console.error("Error: No slot found for this worktree in the registry.");
      process.exit(1);
    }
    const branch = getWorktreeBranch(ctx.currentWorktree) ?? "(detached)";
    return {
      slotPort: entry[0],
      branch,
      worktreePath: ctx.currentWorktree,
      owner: entry[1].owner,
    };
  }

  const branch = command.branch;
  const entry = Object.entries(registry.slots).find(
    ([, v]) => getWorktreeBranch(v.worktree) === branch,
  );
  if (!entry) {
    console.error(`Error: No workspace found for branch "${branch}" in the registry.`);
    process.exit(1);
  }
  const worktreePath = entry[1].worktree;
  if (resolve(ctx.currentWorktree) === resolve(worktreePath)) {
    console.error(
      "Error: You are currently in this worktree. Run `workspace remove` (no branch) instead.",
    );
    process.exit(1);
  }
  return { slotPort: entry[0], branch, worktreePath, owner: entry[1].owner };
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
