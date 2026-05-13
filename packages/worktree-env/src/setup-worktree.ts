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
  isRemoveMode,
  isSetOwnerMode,
  isSetupMode,
  parseSetupArgs,
  printSetupHelp,
  type SetupArgs,
  validateSetupFlags,
} from "./cli.js";
import { removeDevServerEntryByWorktree } from "./dev-servers-registry.js";
import { ConfigError } from "./errors.js";
import { copyAndPatchFile } from "./helpers.js";
import { defaultComputePorts, resolvePortScheme, type PortScheme } from "./ports.js";
import {
  cleanupPidFile,
  isProcessAlive,
  isProcessGroupAlive,
  killProcessGroup,
  readPid,
} from "./process-control.js";
import {
  handleSetOwner,
  markSlotReady,
  readSlots,
  resolveAndRegisterSlot,
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
  /** Anchor port for the slot range. Slots are derived from this value. */
  basePort: number;
  /** Distance between consecutive slots. Defaults to `10`. */
  portStep?: number;
  /** Maximum number of slots. Defaults to `9`. */
  maxSlotCount?: number;
  /** Custom port computation; takes precedence over `portNames`. */
  ports?: (slot: number) => Record<string, number>;
  /** Named offsets `[name0, name1, ...]` mapped to `slot+0`, `slot+1`, ... Required if `ports` is omitted. */
  portNames?: string[];
  /** Directories symlinked from the main worktree. */
  sharedDirs: string[];
  /** Per-worktree runtime directory, relative to the worktree root (e.g. `.local-wt`). */
  localWt: string;
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
    handleSetOwnerMode(args, ctx);
    return;
  }

  await runSetup(args, ctx, run, config);
}

async function runSetup(
  args: SetupArgs,
  ctx: WorktreeContext,
  run: RunCtx,
  config: SetupWorktreeConfig,
): Promise<void> {
  const scheme: PortScheme = resolvePortScheme(config);
  const portsFn = resolvePortsFn(config);

  validateSlotAvailability(args.slot, {
    currentWorktree: ctx.currentWorktree,
    mainWorktree: ctx.mainWorktree,
    scheme,
  });

  const setupCtx = ensureWorktree(args, ctx, run);
  const branch = getCurrentBranch(setupCtx.currentWorktree);
  const { port: slot, owner } = resolveAndRegisterSlot({
    slot: args.slot,
    currentWorktree: setupCtx.currentWorktree,
    mainWorktree: setupCtx.mainWorktree,
    scheme,
    branch,
    requestedOwner: args.owner,
  });
  const ports = portsFn(slot);

  const localWtDir = join(setupCtx.currentWorktree, config.localWt);
  mkdirSync(localWtDir, { recursive: true });
  const logPath = join(localWtDir, "wt-setup.log");
  const logFd = openSync(logPath, "w");
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
  teeLog(`Setup continuing in background. Tail: ${config.localWt}/wt-setup.log`);

  closeSync(logFd);

  // Hand the detached child a fresh fd appended to the same log file; the parent's fd is closed
  // just above so we cannot reuse it.
  const finalizeLogFd = openSync(logPath, "a");
  const child = spawn(process.execPath, [process.argv[1], "--__finalize", String(slot)], {
    detached: true,
    stdio: ["ignore", finalizeLogFd, finalizeLogFd],
    cwd: setupCtx.currentWorktree,
  });
  child.unref();
  closeSync(finalizeLogFd);
}

async function runFinalize(args: SetupArgs, config: SetupWorktreeConfig): Promise<void> {
  const slot = Number(args.__finalize);
  const ctx = detectWorktree();
  const logPath = join(ctx.currentWorktree, config.localWt, "wt-setup.log");
  const appendLog = (message: string): void => {
    appendFileSync(logPath, `${message}\n`);
  };

  const registry = readSlots(ctx.mainWorktree);
  const entry = registry.slots[String(slot)];
  if (!entry || resolve(entry.worktree) !== resolve(ctx.currentWorktree)) {
    appendLog(`FAILED: No matching slot ${slot} for worktree ${ctx.currentWorktree}.`);
    process.exit(1);
  }

  if (entry.ready && !args.force) {
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
    markSlotReady(ctx.mainWorktree, slot);
    appendLog("============================================================");
    appendLog(`READY: branch ${entry.branch} (slot ${slot})`);
    appendLog("============================================================");
  } catch (err) {
    const message = (err as Error).message;
    const stack = (err as Error).stack ?? "";
    appendLog(`FAILED: ${message}`);
    if (stack) appendLog(stack);
    process.exit(1);
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
  const registry = readSlots(ctx.mainWorktree);
  const target = resolveRemoveTarget(args, ctx, registry, removeHere);

  if (!args["no-remote-check"]) {
    verifyBranchAbsentFromRemote(target.branch, run);
  }

  const ownerSuffix = target.owner ? `, owner ${target.owner}` : "";

  if (!existsSync(target.worktreePath)) {
    console.warn(
      `Warning: Worktree directory ${target.worktreePath} not found. Cleaning up registry only.`,
    );
    delete registry.slots[target.slotPort];
    writeSlots(ctx.mainWorktree, registry);
    console.log(
      `Removed registry entry for branch "${target.branch}" (slot ${target.slotPort}${ownerSuffix}).`,
    );
    return;
  }

  await stopAllDevServersInLocalWt(target.worktreePath, config.localWt, verboseLog);

  if (config.teardownInfrastructure) {
    await config.teardownInfrastructure({
      worktree: target.worktreePath,
      mainWorktree: ctx.mainWorktree,
      verbose: run.verbose,
    });
  }

  delete registry.slots[target.slotPort];
  writeSlots(ctx.mainWorktree, registry);
  removeDevServerEntryByWorktree(ctx.mainWorktree, target.worktreePath);

  if (removeHere) {
    process.chdir(ctx.mainWorktree);
  }

  removeWorktree(target.worktreePath, run);

  console.log(
    `Removed worktree for branch "${target.branch}" (slot ${target.slotPort}${ownerSuffix}).`,
  );
  if (removeHere) {
    console.log(`Now run: cd ${ctx.mainWorktree}`);
  }
}

function handleSetOwnerMode(args: SetupArgs, ctx: WorktreeContext): void {
  const newOwner = args["set-owner"];
  const { slotPort } = handleSetOwner({
    newOwner,
    currentWorktree: ctx.currentWorktree,
    mainWorktree: ctx.mainWorktree,
    isMainWorktree: ctx.isMainWorktree,
  });

  // Propagate to dev-servers.json entries for this worktree.
  const devServersPath = join(ctx.mainWorktree, ".local/worktrees/dev-servers.json");
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

async function stopAllDevServersInLocalWt(
  worktreePath: string,
  localWt: string,
  log: (msg: string) => void,
): Promise<void> {
  const dir = join(worktreePath, localWt);
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
