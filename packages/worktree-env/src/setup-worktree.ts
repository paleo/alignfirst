import { spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import {
  isFinalizeMode,
  isInfoMode,
  isRemoveMode,
  isSetOwnerMode,
  isSetupMode,
  isWaitMode,
  parseSetupArgs,
  printSetupHelp,
  type SetupArgs,
  validateSetupFlags,
} from "./cli.js";
import { removeDevServerEntryByWorktree } from "./dev-servers-registry.js";
import { ConfigError } from "./errors.js";
import { copyAndPatchFile } from "./helpers.js";
import { defaultComputePorts, isValidPort, resolvePortScheme, type PortScheme } from "./ports.js";
import {
  cleanupPidFile,
  isProcessAlive,
  isProcessGroupAlive,
  killProcessGroup,
  readPid,
} from "./process-control.js";
import {
  handleSetOwner,
  markSlotFailed,
  markSlotReady,
  readSlots,
  resolveAndRegisterSlot,
  resolveCurrentSlot,
  validateSlotAvailability,
  writeSlots,
} from "./slots.js";
import {
  createBranch,
  detectWorktree,
  enforceWorktreeMode,
  getCurrentBranch,
  removeWorktree,
  type RunCtx,
  useExistingBranch,
  verifyBranchAbsentFromRemote,
  type WorktreeContext,
} from "./worktree.js";

/** Configuration accepted by {@link runSetupWorktree}. */
export interface SetupWorktreeConfig {
  /**
   * Absolute path to the wrapper script that calls `runSetupWorktree`. The package re-spawns this
   * file as a detached child for the finalize phase, so it must point at a runnable Node entrypoint
   * — typically `fileURLToPath(import.meta.url)` from your `setup-worktree.mjs`.
   */
  scriptPath: string;
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
   * Holds the setup log, dev-server PID files, and dev-server logs.
   */
  runtimeDir: string;
  /**
   * Shared registry directory, relative to a worktree root (e.g. `.local/wt-registry`).
   * Holds `slots.json` and `dev-servers.json`. Must resolve to the same physical directory
   * across linked worktrees — typically via a symlink listed in `sharedDirs` (e.g. `.local`).
   */
  registryDir: string;
  /** Config files copied from the main worktree and patched per slot. */
  configFiles: ConfigFileEntry[];
  /**
   * MUST be idempotent. After a failure, the user re-runs `setup-worktree --here` from inside
   * the worktree — this callback will be invoked again with the same context. Re-runs must not
   * error on pre-existing state (created directories, started containers, ran migrations,
   * installed deps, etc.).
   */
  finalizeWorktree: (ctx: SetupContext) => Promise<void> | void;
  /** Tears down infrastructure on `--remove` (e.g. `docker compose down -v`). Best-effort; errors should be swallowed. */
  teardownInfrastructure?: (ctx: TeardownContext) => Promise<void> | void;
  /** Builds the post-setup summary printed to stdout. */
  printSummary: (ctx: SummaryContext) => string;
}

/** Context passed to {@link SetupWorktreeConfig.finalizeWorktree}. */
export interface SetupContext {
  currentWorktree: string;
  mainWorktree: string;
  slot: number;
  branch: string;
  owner?: string;
  ports: Record<string, number>;
  force: boolean;
  verbose: boolean;
}

/** Context passed to {@link SetupWorktreeConfig.printSummary}. */
export interface SummaryContext {
  slot: number;
  branch: string;
  owner?: string;
  ports: Record<string, number>;
  currentWorktree: string;
  mainWorktree: string;
}

/** Context passed to {@link SetupWorktreeConfig.teardownInfrastructure}. */
export interface TeardownContext {
  worktree: string;
  mainWorktree: string;
  verbose: boolean;
}

/** One config file copied from the main worktree and patched per slot. */
export interface ConfigFileEntry {
  /** Path relative to the worktree root. Same path is read from main and written to current. */
  path: string;
  /** Returns the patched content given the source content and the slot's ports. */
  patch: (content: string, ctx: PatchContext) => string;
  /** When `true`, abort if the source file is missing in the main worktree. Defaults to `false`. */
  required?: boolean;
}

/** Context passed to {@link ConfigFileEntry.patch}. */
export interface PatchContext {
  slot: number;
  ports: Record<string, number>;
  mainWorktree: string;
  currentWorktree: string;
}

export async function runSetupWorktree(config: SetupWorktreeConfig): Promise<void> {
  let args: SetupArgs;
  try {
    args = parseSetupArgs();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  const verbose = args.verbose ?? false;

  if (args.help) {
    printSetupHelp();
    return;
  }

  if (!existsSync(config.scriptPath)) {
    console.error(
      `Error: scriptPath does not exist: ${config.scriptPath}. ` +
        "Pass `fileURLToPath(import.meta.url)` from your wrapper script.",
    );
    process.exit(1);
  }

  try {
    validateSetupFlags(args);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(err.exitCode);
    }
    throw err;
  }

  if (isFinalizeMode(args)) {
    await runFinalize(args, config);
    return;
  }

  if (isWaitMode(args) && !isSetupMode(args)) {
    await runWait(args, config);
    return;
  }

  if (isInfoMode(args)) {
    runInfo(args, config);
    return;
  }

  if (!isSetupMode(args) && !isRemoveMode(args) && !isSetOwnerMode(args)) {
    printSetupHelp();
    return;
  }

  const ctx = detectWorktree();
  enforceWorktreeMode(args, ctx);
  const run: RunCtx = { verbose };

  if (isRemoveMode(args)) {
    await handleRemove(args, ctx, run, config);
    return;
  }

  if (isSetOwnerMode(args)) {
    handleSetOwnerMode(args, ctx, config);
    return;
  }

  const { slot } = await runSetup(args, ctx, run, config);

  if (isWaitMode(args)) {
    await waitForSlot(slot, config);
  }
}

async function runSetup(
  args: SetupArgs,
  ctx: WorktreeContext,
  run: RunCtx,
  config: SetupWorktreeConfig,
): Promise<{ slot: number }> {
  const scheme: PortScheme = resolvePortScheme(config);
  const portsFn = resolvePortsFn(config);

  validateSlotAvailability(args.slot, {
    currentWorktree: ctx.currentWorktree,
    mainWorktree: ctx.mainWorktree,
    registryDir: config.registryDir,
    scheme,
  });

  const setupCtx = ensureWorktree(args, ctx, run);
  const branch = getCurrentBranch(setupCtx.currentWorktree);
  const { port: slot, owner } = resolveAndRegisterSlot({
    slot: args.slot,
    currentWorktree: setupCtx.currentWorktree,
    mainWorktree: setupCtx.mainWorktree,
    registryDir: config.registryDir,
    scheme,
    branch,
    requestedOwner: args.owner,
  });
  const ports = portsFn(slot);

  const runtimeDir = join(setupCtx.currentWorktree, config.runtimeDir);
  mkdirSync(runtimeDir, { recursive: true });
  const logPath = join(runtimeDir, "wt-setup.log");
  // Truncate any prior log so `--here` retries start with a clean record (the previous run's
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

  linkSharedDirectories(setupCtx, config.sharedDirs, verboseLog);
  generateConfigFiles(setupCtx, config.configFiles, slot, ports, args.force ?? false, verboseLog);

  teeLog(
    config.printSummary({
      slot,
      branch,
      owner,
      ports,
      currentWorktree: setupCtx.currentWorktree,
      mainWorktree: setupCtx.mainWorktree,
    }),
  );

  teeLog(`WORKTREE_CREATED path=${setupCtx.currentWorktree} branch=${branch} slot=${slot}`);
  teeLog(`Setup continuing in background. Tail: ${logPath}`);

  const child = spawn(process.execPath, [config.scriptPath, "--__finalize", String(slot)], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    cwd: setupCtx.currentWorktree,
  });
  child.unref();
  closeSync(logFd);
  return { slot };
}

async function runFinalize(args: SetupArgs, config: SetupWorktreeConfig): Promise<void> {
  const slot = Number(args.__finalize);
  const ctx = detectWorktree();
  const logPath = join(ctx.currentWorktree, config.runtimeDir, "wt-setup.log");
  const appendLog = (message: string): void => {
    appendFileSync(logPath, `${message}\n`);
  };

  const registry = readSlots(ctx.mainWorktree, config.registryDir);
  const entry = registry.slots[String(slot)];
  if (!entry || resolve(entry.worktree) !== resolve(ctx.currentWorktree)) {
    appendLog(`FAILED: No matching slot ${slot} for worktree ${ctx.currentWorktree}.`);
    process.exit(1);
  }

  if (entry.status === "ready" && !args.force) {
    appendLog(`READY: branch ${entry.branch} (slot ${slot}) already finalized; skipping.`);
    return;
  }

  const portsFn = resolvePortsFn(config);
  const ports = portsFn(slot);

  appendLog(`--- finalizing slot ${slot} at ${new Date().toISOString()} ---`);

  const setupContext: SetupContext = {
    currentWorktree: ctx.currentWorktree,
    mainWorktree: ctx.mainWorktree,
    slot,
    branch: entry.branch,
    owner: entry.owner,
    ports,
    force: args.force ?? false,
    verbose: false,
  };

  try {
    await config.finalizeWorktree(setupContext);
    markSlotReady(ctx.mainWorktree, config.registryDir, slot);
    appendLog("============================================================");
    appendLog(`READY: branch ${entry.branch} (slot ${slot})`);
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

function resolveTargetSlot(args: SetupArgs, config: SetupWorktreeConfig): number {
  if (args.slot !== undefined) {
    const slot = Number(args.slot);
    const scheme = resolvePortScheme(config);
    if (!isValidPort(slot, scheme)) {
      console.error(
        `Error: --slot expects a port in [${scheme.minPort}, ${scheme.maxPort}] stepped by ${scheme.portStep}; got "${args.slot}".`,
      );
      process.exit(1);
    }
    return slot;
  }
  return resolveCurrentSlot(config.basePort, config.registryDir).slot;
}

function printWorktreeInfo(
  config: SetupWorktreeConfig,
  slot: number,
  worktreeForLog: string,
  fallback: { branch: string; owner?: string },
): void {
  const ctx = detectWorktree();
  const registry = readSlots(ctx.mainWorktree, config.registryDir);
  const entry = registry.slots[String(slot)];
  const ports = resolvePortsFn(config)(slot);

  const branch = entry?.branch ?? fallback.branch;
  const owner = entry?.owner ?? fallback.owner;
  // Main worktree has no slot entry by design — treat it as ready when the registry has no row.
  const slotStatus = entry?.status ?? (ctx.isMainWorktree ? "ready" : "pending");
  const logHint = ` (tail ${join(worktreeForLog, config.runtimeDir, "wt-setup.log")})`;
  const display =
    slotStatus === "ready"
      ? "ready"
      : slotStatus === "failed"
        ? `failed: ${entry?.failure?.message ?? "(no message)"}${logHint}`
        : `pending${logHint}`;
  console.log(`Status: ${display}`);
  console.log(
    config.printSummary({
      slot,
      branch,
      owner,
      ports,
      currentWorktree: entry?.worktree ?? ctx.currentWorktree,
      mainWorktree: ctx.mainWorktree,
    }),
  );
}

function runInfo(args: SetupArgs, config: SetupWorktreeConfig): void {
  if (args.slot !== undefined) {
    const slot = resolveTargetSlot(args, config);
    const ctx = detectWorktree();
    const entry = readSlots(ctx.mainWorktree, config.registryDir).slots[String(slot)];
    if (!entry) {
      console.error(`Error: No slot ${slot} in registry.`);
      process.exit(1);
    }
    printWorktreeInfo(config, slot, entry.worktree, { branch: entry.branch, owner: entry.owner });
    return;
  }
  const resolved = resolveCurrentSlot(config.basePort, config.registryDir);
  printWorktreeInfo(config, resolved.slot, ".", { branch: resolved.branch, owner: resolved.owner });
}

async function runWait(args: SetupArgs, config: SetupWorktreeConfig): Promise<void> {
  const slot = resolveTargetSlot(args, config);
  await waitForSlot(slot, config);
}

async function waitForSlot(slot: number, config: SetupWorktreeConfig): Promise<void> {
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
      printWorktreeInfo(config, slot, entry.worktree, { branch: entry.branch, owner: entry.owner });
      return;
    }
    if (entry.status === "failed") {
      const logPath = join(entry.worktree, config.runtimeDir, "wt-setup.log");
      console.error(`FAILED: ${entry.failure?.message ?? "(no message)"}`);
      console.error(`Full log: ${logPath}`);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

async function handleRemove(
  args: SetupArgs,
  ctx: WorktreeContext,
  run: RunCtx,
  config: SetupWorktreeConfig,
): Promise<void> {
  const verboseLog = makeVerboseLog(run.verbose);
  const removeHere = Boolean(args["remove-here"]);
  const registry = readSlots(ctx.mainWorktree, config.registryDir);
  const target = resolveRemoveTarget(args, ctx, registry, removeHere);

  // Refuse to remove while the detached finalize is still writing to slots.json / wt-setup.log:
  // racing the two corrupts the registry and leaves the worktree directory orphaned.
  if (registry.slots[target.slotPort]?.status === "pending") {
    console.error(
      `Error: Setup is still in progress for slot ${target.slotPort}. ` +
        `Run 'setup-worktree --wait --slot ${target.slotPort}' to wait for it to finish (or fail), then retry --remove.`,
    );
    process.exit(1);
  }

  if (!args["no-remote-check"]) {
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

  await stopAllDevServersInRuntimeDir(target.worktreePath, config.runtimeDir, verboseLog);

  if (config.teardownInfrastructure) {
    await config.teardownInfrastructure({
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
    `Removed worktree for branch "${target.branch}" (slot ${target.slotPort}${ownerSuffix}). ` +
      `Branch "${target.branch}" kept.`,
  );
  if (removeHere) {
    console.log(`Now run: cd ${ctx.mainWorktree}`);
  }
}

function handleSetOwnerMode(
  args: SetupArgs,
  ctx: WorktreeContext,
  config: SetupWorktreeConfig,
): void {
  const newOwner = args["set-owner"];
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

function ensureWorktree(args: SetupArgs, ctx: WorktreeContext, run: RunCtx): WorktreeContext {
  if (args.use) return useExistingBranch(args.use, ctx, run);
  if (args.create) return createBranch(args.create, ctx, run);
  return ctx;
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
    copyAndPatchFile(
      { currentWorktree: ctx.currentWorktree, mainWorktree: ctx.mainWorktree, log },
      entry.path,
      (content) =>
        entry.patch(content, {
          slot,
          ports,
          mainWorktree: ctx.mainWorktree,
          currentWorktree: ctx.currentWorktree,
        }),
      entry.path,
      force,
      entry.required ?? false,
    );
  }
}

interface RemoveTarget {
  slotPort: string;
  branch: string;
  worktreePath: string;
  owner?: string;
}

function resolveRemoveTarget(
  args: SetupArgs,
  ctx: WorktreeContext,
  registry: ReturnType<typeof readSlots>,
  removeHere: boolean,
): RemoveTarget {
  if (removeHere) {
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
    return {
      slotPort: entry[0],
      branch: entry[1].branch,
      worktreePath: ctx.currentWorktree,
      owner: entry[1].owner,
    };
  }

  const branch = args.remove ?? "";
  const entry = Object.entries(registry.slots).find(([, v]) => v.branch === branch);
  if (!entry) {
    console.error(`Error: No worktree found for branch "${branch}" in the slot registry.`);
    process.exit(1);
  }
  const worktreePath = entry[1].worktree;
  if (resolve(ctx.currentWorktree) === resolve(worktreePath)) {
    console.error("Error: You are currently in this worktree. Use --remove-here instead.");
    process.exit(1);
  }
  return { slotPort: entry[0], branch, worktreePath, owner: entry[1].owner };
}

async function stopAllDevServersInRuntimeDir(
  worktreePath: string,
  runtimeDir: string,
  log: (msg: string) => void,
): Promise<void> {
  const dir = join(worktreePath, runtimeDir);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.endsWith(".pid")) continue;
    const pidFile = join(dir, name);
    const pid = readPid(pidFile);
    if (pid === undefined) continue;
    if (!isProcessAlive(pid)) {
      cleanupPidFile(pidFile);
      continue;
    }
    log(`Stopping dev server (PID ${pid})...`);
    killProcessGroup(pid, "SIGTERM");
    const deadline = Date.now() + 5_000;
    let stillAlive = true;
    while (Date.now() < deadline) {
      if (!isProcessGroupAlive(pid)) {
        stillAlive = false;
        break;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    if (stillAlive) {
      killProcessGroup(pid, "SIGKILL");
    }
    cleanupPidFile(pidFile);
  }
}

function resolvePortsFn(config: SetupWorktreeConfig): (slot: number) => Record<string, number> {
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
