import { findOwnEntry } from "./dev-servers-registry.js";
import { ConfigError, errorMessage, WorkspaceError } from "./errors.js";
import {
  type RunFileContext,
  type RunFileEntry,
  type SetupContextBase,
  seedFiles,
} from "./file-entries.js";
import { formatDuration, setupLogPath } from "./helpers.js";
import { devCmd, type PackageManagerCommands, packageManagerCommands } from "./package-manager.js";
import { formatPorts, isPortFree, type ResolvedDevPorts, reconcilePorts } from "./ports.js";
import { isProcessAlive } from "./process-control.js";
import {
  allocateWorkspaceName,
  findWorkspaceByPath,
  readWorkspaces,
  resolveCurrentWorkspace,
  type ResolvedWorkspace,
  type RunFilesBasis,
  updateWorkspaces,
  type WorkspaceEntry,
  type WorkspacesRegistry,
} from "./workspaces.js";
import type { WorktreeContext } from "./worktree.js";

/** Context passed to `DevServerConfig.setup`. */
export interface DevSetupContext extends SetupContextBase {
  ports: Record<string, number>;
  /** Mirrors `dev setup --force`. */
  force: boolean;
  log: (msg: string) => void;
}

export interface DevSetupInput {
  worktree: WorktreeContext;
  registryDir: string;
  runtimeDir: string;
  /** Omit for a portless dev-server. */
  ports?: ResolvedDevPorts;
  runFiles: RunFileEntry[];
  runFilesInputs?: () => Record<string, string | undefined>;
  setup?: (ctx: DevSetupContext) => Promise<void> | void;
  options: DevSetupOptions;
}

export interface DevSetupOptions {
  /** Reruns `setup`. */
  force: boolean;
  /** Allocates every port again, pins excepted. */
  resetPorts: boolean;
  /** Set only by the finalize child of `workspace setup --full`: a `pending` workspace passes. */
  fromFinalize: boolean;
  /** Set by the implicit `dev setup` of a start: existing run files follow a changed basis only. */
  beforeStart: boolean;
}

export interface DevSetupResult {
  workspace: ResolvedWorkspace;
  ports: Record<string, number>;
}

/**
 * `dev setup`, explicit or implicit before each start: resolves the workspace, reconciles its
 * ports, writes the run files ({@link writeRunFiles}), and runs the `setup` hook once per
 * workspace. A failure after the ready check is recorded as the entry's `devSetupFailure`.
 */
export async function runDevSetup(input: DevSetupInput): Promise<DevSetupResult> {
  const { worktree, registryDir, options } = input;
  const { mainWorktree } = worktree;
  if (options.resetPorts) refuseWhileRunning(mainWorktree, registryDir, worktree.currentWorktree);
  const workspace = worktree.isMainWorktree
    ? await ensureMainEntry(mainWorktree, registryDir)
    : resolveCurrentWorkspace(mainWorktree, registryDir, worktree.currentWorktree);
  const entry = readWorkspaces(mainWorktree, registryDir).workspaces[workspace.name];
  if (!entry) throw new WorkspaceError(`No workspace "${workspace.name}" in the registry.`);
  checkReady(input, workspace, entry);

  try {
    const ports = await reconcileWorkspacePorts(input, workspace, entry);
    const base: SetupContextBase = {
      name: workspace.name,
      currentWorktree: workspace.worktree,
      mainWorktree,
      isMainWorktree: workspace.main === true,
    };
    await writeRunFiles(input, { ...base, ports }, entry.runFilesWrittenWith);
    await runSetupHook(input, { ...base, ports, force: options.force, log: console.log }, entry);
    return { workspace, ports };
  } catch (err) {
    await recordDevSetupFailure(mainWorktree, registryDir, workspace.worktree, errorMessage(err));
    throw asKernelError(err);
  }
}

function refuseWhileRunning(mainWorktree: string, registryDir: string, worktree: string): void {
  const entry = findOwnEntry(mainWorktree, registryDir, worktree);
  if (!entry || !Object.values(entry.pids).some(isProcessAlive)) return;
  throw new WorkspaceError(
    `The dev-server of this worktree is running. Stop it with \`${devCmd("down")}\`, then run ` +
      `\`${devCmd("setup --reset-ports")}\` again.`,
  );
}

/** Re-keys a renamed main entry, or creates a `ready` main entry when there is none. */
async function ensureMainEntry(
  mainWorktree: string,
  registryDir: string,
): Promise<ResolvedWorkspace> {
  return updateWorkspaces(mainWorktree, registryDir, (registry) => {
    const existing = findWorkspaceByPath(registry, mainWorktree);
    if (existing?.entry.main === true) {
      return { name: existing.name, worktree: existing.entry.worktree, main: true };
    }
    const name = allocateWorkspaceName(registry.workspaces, mainWorktree);
    registry.workspaces[name] = {
      worktree: mainWorktree,
      createdAt: new Date().toISOString(),
      status: "ready",
      main: true,
      neverFinalized: true,
    };
    return { name, worktree: mainWorktree, main: true };
  });
}

function checkReady(
  input: DevSetupInput,
  workspace: ResolvedWorkspace,
  entry: WorkspaceEntry,
): void {
  const result = buildWorktreeReadyMessage({
    name: workspace.name,
    worktreePath: workspace.worktree,
    runtimeDir: input.runtimeDir,
    entry,
    now: Date.now(),
    pm: packageManagerCommands(),
    acceptPending: input.options.fromFinalize,
  });
  if (result.ok) return;
  console.error(result.message);
  process.exit(1);
}

export type WorktreeReadyCheck = { ok: true } | { ok: false; message: string };

/**
 * Pure builder for the worktree-readiness gate of `dev setup`. Returns `ok` when the workspace is
 * `ready`, or `pending` with `acceptPending`; otherwise returns the user-facing error message.
 */
export function buildWorktreeReadyMessage(input: {
  name: string;
  worktreePath: string;
  runtimeDir: string;
  entry: WorkspaceEntry;
  now: number;
  pm: PackageManagerCommands;
  acceptPending?: boolean;
}): WorktreeReadyCheck {
  const { name, worktreePath, runtimeDir, entry, now, pm } = input;
  if (entry.status === "ready") return { ok: true };
  if (entry.status === "pending" && input.acceptPending === true) return { ok: true };
  const ws = pm.workspace.withArgs;
  const logPath = setupLogPath(worktreePath, runtimeDir);
  if (entry.status === "pending") {
    const elapsed = formatDuration(now - Date.parse(entry.createdAt));
    return {
      ok: false,
      message:
        `Error: Worktree setup is still in progress (workspace ${name}, started ${elapsed} ago).\n` +
        `Tail: ${logPath}\n` +
        `Run \`${ws} wait\` to block until it finishes, or retry \`${pm.dev.base}\` once ready.`,
    };
  }
  const failureAt = entry.failure?.at ?? entry.createdAt;
  const elapsed = formatDuration(now - Date.parse(failureAt));
  const reason = entry.failure?.message ?? "(no message)";
  return {
    ok: false,
    message:
      `Error: Worktree setup failed (workspace ${name}, ${elapsed} ago): ${reason}\n` +
      `Tail: ${logPath}\n` +
      `Re-run \`${ws} setup\` to retry the finalize.`,
  };
}

/**
 * Reconciles and stores the workspace's ports under the registry lock; the listen probes run
 * inside it. Without a `ports` group, the stored ports are returned untouched.
 */
async function reconcileWorkspacePorts(
  input: DevSetupInput,
  workspace: ResolvedWorkspace,
  entry: WorkspaceEntry,
): Promise<Record<string, number>> {
  const config = input.ports;
  if (config === undefined) return entry.ports ?? {};
  const { mainWorktree } = input.worktree;
  const { ports, changed } = await updateWorkspaces(
    mainWorktree,
    input.registryDir,
    async (registry) => {
      const found = findWorkspaceByPath(registry, workspace.worktree);
      if (!found) throw new WorkspaceError(`Workspace "${workspace.name}" left the registry.`);
      const current = found.entry;
      const previous = current.ports ?? {};
      const next = await reconcilePorts({
        config,
        isMainWorktree: workspace.main === true,
        stored: input.options.resetPorts ? {} : previous,
        others: portsOfOtherEntries(registry, found.name),
        isFree: isPortFree,
      });
      current.ports = next;
      return { ports: next, changed: !sameValues(previous, next) };
    },
  );
  if (changed) console.log(`Ports: ${formatPorts(ports)}`);
  return ports;
}

function portsOfOtherEntries(registry: WorkspacesRegistry, name: string): number[] {
  return Object.entries(registry.workspaces)
    .filter(([other]) => other !== name)
    .flatMap(([, entry]) => Object.values(entry.ports ?? {}));
}

function sameValues<T>(a: Record<string, T>, b: Record<string, T>): boolean {
  return changedKeys(a, b).length === 0;
}

function changedKeys<T>(a: Record<string, T>, b: Record<string, T>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((key) => a[key] !== b[key]);
}

/**
 * Creates the missing run files. An explicit `dev setup` rewrites the existing ones; a start does
 * only when the ports or the run-file inputs changed since the last write, and warns, so a hand
 * edit survives a restart. A generated run file — a `content` source without `patch` — is
 * regenerated whenever it is rewritten. Run files are never reseeded from a path source.
 */
async function writeRunFiles(
  input: DevSetupInput,
  ctx: RunFileContext,
  written: RunFilesBasis | undefined,
): Promise<void> {
  const { beforeStart } = input.options;
  const basis: RunFilesBasis = { ports: ctx.ports, inputs: definedValues(input.runFilesInputs) };
  const changed =
    written === undefined ||
    !sameValues(written.ports, basis.ports) ||
    !sameValues(written.inputs, basis.inputs);
  const rewrite = !beforeStart || changed;
  const entries = rewrite ? regeneratedRunFiles(input.runFiles, ctx) : input.runFiles;
  const tee = beforeStart
    ? (msg: string) => console.warn(rewriteWarning(written, basis, msg))
    : console.log;
  await storeRunFilesBasis(input, ctx.currentWorktree, undefined);
  await seedFiles({
    entries,
    ctx,
    existing: rewrite ? "patch" : "keep",
    log: { tee, verbose: noop },
  });
  await storeRunFilesBasis(input, ctx.currentWorktree, basis);
}

/** The inputs without their `undefined` values, as the registry stores them. */
function definedValues(runFilesInputs: DevSetupInput["runFilesInputs"]): Record<string, string> {
  const inputs: Record<string, string> = {};
  for (const [key, value] of Object.entries(runFilesInputs?.() ?? {})) {
    if (value !== undefined) inputs[key] = value;
  }
  return inputs;
}

/** Resolves each generated source after the preceding entry has been written. */
async function* regeneratedRunFiles(
  entries: RunFileEntry[],
  ctx: RunFileContext,
): AsyncGenerator<RunFileEntry> {
  for (const entry of entries) {
    const { source } = entry;
    if (source.kind !== "content" || entry.patch !== undefined) {
      yield entry;
      continue;
    }
    const content =
      typeof source.content === "function" ? await source.content(ctx) : source.content;
    yield { ...entry, source: { kind: "content", content }, patch: () => content };
  }
}

/** Names the changes; the values of the inputs stay out, as they may be private. */
function rewriteWarning(
  written: RunFilesBasis | undefined,
  basis: RunFilesBasis,
  updatedLine: string,
): string {
  if (written === undefined) {
    return `Warning: the run files had no recorded ports or inputs. ${updatedLine}`;
  }
  const changes: string[] = [];
  const moves = changedKeys(written.ports, basis.ports).map(
    (name) => `${name} ${written.ports[name] ?? "none"} → ${basis.ports[name] ?? "none"}`,
  );
  if (moves.length > 0) changes.push(`the ports moved (${moves.join(", ")})`);
  const inputs = changedKeys(written.inputs, basis.inputs);
  if (inputs.length > 0) changes.push(`the run-file inputs changed (${inputs.join(", ")})`);
  return `Warning: ${changes.join("; ")}. ${updatedLine}`;
}

async function storeRunFilesBasis(
  input: DevSetupInput,
  worktree: string,
  basis: RunFilesBasis | undefined,
): Promise<void> {
  await updateWorkspaces(input.worktree.mainWorktree, input.registryDir, (registry) => {
    const current = findWorkspaceByPath(registry, worktree)?.entry;
    if (!current) return;
    if (basis === undefined) delete current.runFilesWrittenWith;
    else current.runFilesWrittenWith = basis;
  });
}

function noop(): void {}

/**
 * Runs the hook when the workspace was never set up, or with `--force`, then stores `devSetupAt`.
 * A successful run clears `devSetupFailure`.
 */
async function runSetupHook(
  input: DevSetupInput,
  ctx: DevSetupContext,
  entry: WorkspaceEntry,
): Promise<void> {
  const { setup } = input;
  const runs = setup !== undefined && (entry.devSetupAt === undefined || ctx.force);
  if (runs) await setup(ctx);
  if (!runs && entry.devSetupFailure === undefined) return;
  await updateWorkspaces(input.worktree.mainWorktree, input.registryDir, (registry) => {
    const current = findWorkspaceByPath(registry, ctx.currentWorktree)?.entry;
    if (!current) return;
    if (runs) current.devSetupAt = new Date().toISOString();
    delete current.devSetupFailure;
  });
}

async function recordDevSetupFailure(
  mainWorktree: string,
  registryDir: string,
  worktree: string,
  message: string,
): Promise<void> {
  await updateWorkspaces(mainWorktree, registryDir, (registry) => {
    const entry = findWorkspaceByPath(registry, worktree)?.entry;
    if (entry) entry.devSetupFailure = { at: new Date().toISOString(), message };
  });
}

/** A hook's own error becomes a `WorkspaceError`, so the CLI reports it without a stack trace. */
function asKernelError(err: unknown): Error {
  if (err instanceof WorkspaceError || err instanceof ConfigError) return err;
  return new WorkspaceError(`dev setup failed: ${errorMessage(err)}`, { cause: err });
}
