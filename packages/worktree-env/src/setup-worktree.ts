import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import {
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
  /** Directories symlinked from the main worktree. Defaults to `[".local", ".plans"]`. */
  sharedDirs?: string[];
  /** PID files written by `dev-server`, used by `--remove` to stop processes before teardown. */
  devServerPidFiles: string[];
  /** Config files copied from the main worktree and patched per slot. */
  configFiles: ConfigFileEntry[];
  /**
   * Runs after symlinks and config files. Owns per-worktree data setup:
   * create any required directories (e.g. `.local-wt/...`), copy or
   * provision databases / file storage, start infrastructure containers.
   */
  setupWorktreeData: (ctx: SetupContext) => Promise<void> | void;
  /** Tears down infrastructure on `--remove` (e.g. `docker compose down -v`). Best-effort; errors should be swallowed. */
  teardownInfrastructure?: (ctx: TeardownContext) => Promise<void> | void;
  /** Runs after `setupWorktreeData`. Typically `npm install && npm run build`. */
  installAndBuild: (ctx: SetupContext) => Promise<void> | void;
  /** Runs after `installAndBuild`. Typically migrations and seeds. */
  afterDatabase?: (ctx: SetupContext) => Promise<void> | void;
  /** Builds the post-setup summary printed to stdout. */
  printSummary: (ctx: SummaryContext) => string;
}

/** Context passed to setup-time hooks (`setupWorktreeData`, `installAndBuild`, `afterDatabase`). */
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
  const verboseLog = makeVerboseLog(run.verbose);
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

  verboseLog(
    `Using slot ${slot} (${Object.entries(ports)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ")})`,
  );

  console.log(`WORKTREE_CREATED path=${setupCtx.currentWorktree} branch=${branch} slot=${slot}`);

  const sharedDirs = config.sharedDirs ?? [".local", ".plans"];

  linkSharedDirectories(setupCtx, sharedDirs, verboseLog);
  generateConfigFiles(setupCtx, config.configFiles, slot, ports, args.force ?? false, verboseLog);

  const force = args.force ?? false;
  const setupContext: SetupContext = {
    currentWorktree: setupCtx.currentWorktree,
    mainWorktree: setupCtx.mainWorktree,
    slot,
    branch,
    owner,
    ports,
    force,
    verbose: run.verbose,
  };

  await config.setupWorktreeData(setupContext);
  await config.installAndBuild(setupContext);
  if (config.afterDatabase) await config.afterDatabase(setupContext);

  console.log(
    config.printSummary({
      slot,
      branch,
      owner,
      ports,
      currentWorktree: setupCtx.currentWorktree,
      mainWorktree: setupCtx.mainWorktree,
    }),
  );
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

  await stopDevServerByPidFiles(target.worktreePath, config.devServerPidFiles, verboseLog);

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

async function stopDevServerByPidFiles(
  worktreePath: string,
  pidFiles: string[],
  log: (msg: string) => void,
): Promise<void> {
  for (const pidFileRel of pidFiles) {
    const pidFile = join(worktreePath, pidFileRel);
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
