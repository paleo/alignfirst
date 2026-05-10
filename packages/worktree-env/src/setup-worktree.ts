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
import {
  cleanupPidFile,
  isProcessAlive,
  isProcessGroupAlive,
  killProcessGroup,
  readPid,
} from "./process-control.js";

export interface SetupContext {
  currentWorktree: string;
  mainWorktree: string;
  slot: number;
  branch: string;
  owner: string;
  ports: Record<string, number>;
  force: boolean;
  verbose: boolean;
}

export interface PatchContext {
  slot: number;
  ports: Record<string, number>;
  mainWorktree: string;
  currentWorktree: string;
}

export interface ConfigFileEntry {
  path: string;
  patch: (content: string, ctx: PatchContext) => string;
  required?: boolean;
}

export interface SummaryContext {
  slot: number;
  branch: string;
  owner: string;
  ports: Record<string, number>;
  currentWorktree: string;
  mainWorktree: string;
}

export interface TeardownContext {
  worktree: string;
  mainWorktree: string;
  verbose: boolean;
}

export interface SetupWorktreeConfig {
  basePort: number;
  portStep?: number;
  maxSlotCount?: number;
  ports?: (slot: number) => Record<string, number>;
  portNames?: string[];
  perWorktreeDirs?: string[];
  sharedDirs?: string[];
  devServerPidFiles: string[];
  devLimitEnvVar?: string;
  configFiles: ConfigFileEntry[];
  provisionDatabase: (ctx: SetupContext) => Promise<void> | void;
  teardownInfrastructure?: (ctx: TeardownContext) => Promise<void> | void;
  installAndBuild: (ctx: SetupContext) => Promise<void> | void;
  afterDatabase?: (ctx: SetupContext) => Promise<void> | void;
  printSummary: (ctx: SummaryContext) => string;
}

function makeLog(verbose: boolean): (msg: string) => void {
  return (msg) => {
    if (verbose) console.log(msg);
  };
}

function resolvePortsFn(config: SetupWorktreeConfig): (slot: number) => Record<string, number> {
  if (config.ports) return config.ports;
  if (config.portNames && config.portNames.length > 0) {
    return defaultComputePorts(config.portNames);
  }
  throw new ConfigError("Config error: provide either `ports` (function) or `portNames` (array).");
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
  const log = makeLog(run.verbose);
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

  log(
    `Using slot ${slot} (${Object.entries(ports)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ")})`,
  );

  const sharedDirs = config.sharedDirs ?? [".local", ".plans"];
  const perWorktreeDirs = config.perWorktreeDirs ?? [".local-data"];

  setupLocalDirectories(setupCtx.currentWorktree, perWorktreeDirs);
  linkSharedDirectories(setupCtx, sharedDirs, log);
  generateConfigFiles(setupCtx, config.configFiles, slot, ports, args.force ?? false, log);

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

  await config.provisionDatabase(setupContext);
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

function ensureWorktree(args: SetupArgs, ctx: WorktreeContext, run: RunCtx): WorktreeContext {
  if (args.use) return useExistingBranch(args.use, ctx, run);
  if (args.create) return createBranch(args.create, ctx, run);
  return ctx;
}

function setupLocalDirectories(worktreePath: string, dirs: string[]): void {
  for (const dir of dirs) {
    mkdirSync(join(worktreePath, dir), { recursive: true });
  }
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
}

function resolveRemoveTarget(
  args: SetupArgs,
  ctx: WorktreeContext,
  registry: ReturnType<typeof readSlots>,
  removeSelf: boolean,
): RemoveTarget {
  if (removeSelf) {
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
    return { slotPort: entry[0], branch: entry[1].branch, worktreePath: ctx.currentWorktree };
  }

  const branch = args.remove ?? "";
  const entry = Object.entries(registry.slots).find(([, v]) => v.branch === branch);
  if (!entry) {
    console.error(`Error: No worktree found for branch "${branch}" in the slot registry.`);
    process.exit(1);
  }
  const worktreePath = entry[1].worktree;
  if (resolve(ctx.currentWorktree) === resolve(worktreePath)) {
    console.error("Error: You are currently in this worktree. Use --remove-self instead.");
    process.exit(1);
  }
  return { slotPort: entry[0], branch, worktreePath };
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

async function handleRemove(
  args: SetupArgs,
  ctx: WorktreeContext,
  run: RunCtx,
  config: SetupWorktreeConfig,
): Promise<void> {
  const log = makeLog(run.verbose);
  const removeSelf = Boolean(args["remove-self"]);
  const registry = readSlots(ctx.mainWorktree);
  const target = resolveRemoveTarget(args, ctx, registry, removeSelf);

  if (!args["no-remote-check"]) {
    verifyBranchAbsentFromRemote(target.branch, run);
  }

  if (!existsSync(target.worktreePath)) {
    console.warn(
      `Warning: Worktree directory ${target.worktreePath} not found. Cleaning up registry only.`,
    );
    delete registry.slots[target.slotPort];
    writeSlots(ctx.mainWorktree, registry);
    console.log(`Removed registry entry for branch "${target.branch}" (slot ${target.slotPort}).`);
    return;
  }

  await stopDevServerByPidFiles(target.worktreePath, config.devServerPidFiles, log);

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

  if (removeSelf) {
    process.chdir(ctx.mainWorktree);
  }

  removeWorktree(target.worktreePath, run);

  console.log(`Removed worktree for branch "${target.branch}" (slot ${target.slotPort}).`);
  if (removeSelf) {
    console.log(`Now run: cd ${ctx.mainWorktree}`);
  }
}

function handleSetOwnerMode(args: SetupArgs, ctx: WorktreeContext): void {
  const newOwner = args["set-owner"] ?? "default";
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
      servers: { worktree: string; owner: string }[];
    };
    let changed = false;
    const resolvedCurrent = resolve(ctx.currentWorktree);
    for (const server of data.servers) {
      if (resolve(server.worktree) === resolvedCurrent) {
        server.owner = newOwner;
        changed = true;
      }
    }
    if (changed) {
      mkdirSync(dirname(devServersPath), { recursive: true });
      writeFileSync(devServersPath, `${JSON.stringify(data, undefined, 2)}\n`);
    }
  }

  console.log(`Owner for slot ${slotPort}: ${newOwner}`);
}
