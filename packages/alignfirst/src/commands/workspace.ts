import {
  adaptWorkspaceManifest,
  assertRegistryOwnership,
  assertWorkspaceRecipe,
  assertWorkspaceCleanupComplete,
  assertDistinctDestinations,
  ConfigError,
  defaultCommands,
  detectWorktree,
  findWorkspaceByPath,
  parseDevArgs,
  parseWorkspaceArgs,
  readWorkspaceInventory,
  readWorkspaces,
  registryDirFor,
  renderWorkspaceHelp,
  renderDevHelp,
  runDevServer,
  runWorkspace,
  selectWorkspaceRecord,
  type WorkspaceRecipe,
  validateRuntimeStorage,
  WorkspaceError,
  type WorkspaceConfig,
  type WorkspaceHost,
  type WorkspaceOperation,
  type WorkspaceOutput,
  type WorkspaceRecord,
} from "@alignfirst/workspace";
import { git, canonicalPath } from "@alignfirst/workspace/git";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CliError } from "../cli-error.js";
import type { CommandContext } from "../context.js";
import { resolvePlansMode } from "../plans/mode.js";
import { resolveProjectConfig } from "../project-config.js";
import {
  assertCompanionLifecycleAdmission,
  resolveProjectLayout,
  projectRoot,
  type ProjectLayout,
} from "../project-layout.js";

export async function runWorkspaceCommand(ctx: CommandContext, args: string[]): Promise<number> {
  const controller = new AbortController();
  const cancel = (): void => controller.abort(new Error("Workspace operation cancelled."));
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    const parsed = parseWorkspaceArgs(args);
    const output = workspaceOutput(ctx, parsed.json === true);
    const operation = workspaceOperation(ctx, output, controller.signal);
    if (parsed.command.kind === "help" || parsed.command.kind === "version") {
      output.text(
        parsed.command.kind === "help" ? renderWorkspaceHelp(operation.commands) : ctx.version,
      );
      return 0;
    }
    const root = detectWorktree(ctx.cwd);
    const config = loadRecipe(ctx, root.currentWorktree, output, controller.signal, ctx.layout);
    const informational = ["help", "guide", "version", "list", "status"].includes(
      parsed.command.kind,
    );
    const registryDir = config.storage?.registryDir ?? registryDirFor(config.runtimeDir);
    assertRegistryOwnership(root.mainWorktree, root.currentWorktree, registryDir);
    if (!informational) assertRegisteredRecipe(root.currentWorktree, config.recipe, registryDir);
    const before =
      parsed.json === true && ["teardown", "remove", "prune"].includes(parsed.command.kind)
        ? readWorkspaceInventory({ cwd: ctx.cwd, env: ctx.env }, registryDir)
        : undefined;
    const outcome = await runWorkspace(config, { ...operation, ...parsed });
    if (parsed.json !== true) return 0;
    const command = parsed.command;
    if (command.kind === "prune") {
      const remaining = readWorkspaceInventory({ cwd: ctx.cwd, env: ctx.env }, registryDir);
      const pruned =
        before?.workspaces
          .filter(
            (entry) =>
              !entry.exists &&
              !entry.main &&
              (entry.name !== null || entry.runtimeState !== null) &&
              !remaining.workspaces.some(
                (row) =>
                  row.path === entry.path && (row.name !== null || row.runtimeState !== null),
              ),
          )
          .map(({ path, name }) => ({ path, name })) ?? [];
      ctx.stdout.write(`${JSON.stringify({ mainWorktree: root.mainWorktree, pruned })}\n`);
      return 0;
    }
    if (command.kind === "remove" || command.kind === "teardown") {
      if (!before) throw new WorkspaceError("Missing cleanup inventory.");
      const record = selectWorkspaceRecord(
        before,
        root.currentWorktree,
        selectorPath(command.selector.dir, ctx.cwd, before.workspaces),
      );
      ctx.stdout.write(
        `${JSON.stringify({ mainWorktree: root.mainWorktree, path: record.path, name: record.name, operation: command.kind, completed: true })}\n`,
      );
      return 0;
    }
    const inventory = readWorkspaceInventory({ cwd: root.mainWorktree, env: ctx.env }, registryDir);
    if (command.kind === "list") ctx.stdout.write(`${JSON.stringify(inventory)}\n`);
    else {
      const selector =
        command.kind === "status" || command.kind === "wait"
          ? command.selector.dir
          : outcome?.worktree;
      const workspace = selectWorkspaceRecord(
        inventory,
        root.currentWorktree,
        selectorPath(selector, ctx.cwd, inventory.workspaces),
      );
      ctx.stdout.write(`${JSON.stringify({ mainWorktree: inventory.mainWorktree, workspace })}\n`);
    }
    return 0;
  } catch (error) {
    throw workspaceCliError(error);
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}

function selectorPath(
  selector: string | undefined,
  cwd: string,
  records: WorkspaceRecord[],
): string | undefined {
  if (selector === undefined) return;
  const path = canonicalPath(resolve(cwd, selector));
  if (records.some((record) => record.path === path)) return path;
  return selector;
}

export async function runDevCommand(ctx: CommandContext, args: string[]): Promise<number> {
  const controller = new AbortController();
  const cancel = (): void => controller.abort(new Error("Dev operation cancelled."));
  let ownsCancellation = false;
  try {
    const command = parseDevArgs(args);
    if (command.kind === "help") {
      ctx.stdout.write(
        `${renderDevHelp(workspaceOperation(ctx, workspaceOutput(ctx, false)).commands)}\n`,
      );
      return 0;
    }
    // Foreground distinguishes non-owning attach from server shutdown; other commands cancel here.
    ownsCancellation = command.kind !== "foreground";
    if (ownsCancellation) {
      process.on("SIGINT", cancel);
      process.on("SIGTERM", cancel);
    }
    const output = workspaceOutput(ctx, false);
    const operation = workspaceOperation(ctx, output, controller.signal);
    const root = detectWorktree(ctx.cwd);
    const selected = operation.host?.loadWorkspace?.(root.currentWorktree);
    if (selected === undefined) throw new WorkspaceError("Missing workspace configuration host.");
    const recipe = selected.recipe;
    const registryDir = selected.storage?.registryDir ?? registryDirFor(selected.runtimeDir);
    assertRegistryOwnership(root.mainWorktree, root.currentWorktree, registryDir);
    const adapted = adaptWorkspaceManifest(selected.settings ?? {}, {
      recipe,
      mainWorktree: root.mainWorktree,
      configurationDir: selected.configurationDir,
      companionDir: selected.companionDir,
      storage: selected.storage,
      env: ctx.env,
      output,
      signal: controller.signal,
    });
    const needsServices = ["foreground", "setup", "up", "restart"].includes(command.kind);
    if (needsServices && adapted.devServer === undefined)
      throw new WorkspaceError("No dev services declared in the workspace manifest.");
    if (needsServices) {
      const registered = findWorkspaceByPath(
        readWorkspaces(root.mainWorktree, registryDir),
        root.currentWorktree,
      );
      assertWorkspaceCleanupComplete(registered?.entry);
      if (!root.isMainWorktree && !registered)
        throw new WorkspaceError(
          "No workspace here. Run alignfirst workspace setup before dev setup/start.",
        );
      assertRegisteredRecipe(root.currentWorktree, recipe, registryDir);
      validateRuntimeStorage({ cwd: root.mainWorktree, env: ctx.env }, selected.storage);
      validateRuntimeStorage({ cwd: root.currentWorktree, env: ctx.env }, selected.storage);
      await operation.host?.validateWorkFiles(root.currentWorktree);
    }
    await runDevServer(
      adapted.devServer ?? {
        runtimeDir: ".local-wt",
        storage: selected.storage,
        recipe,
        servers: [],
        signal: controller.signal,
      },
      {
        ...operation,
        command,
      },
    );
    return 0;
  } catch (error) {
    throw workspaceCliError(error);
  } finally {
    if (ownsCancellation) {
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    }
  }
}

function workspaceOperation(
  ctx: CommandContext,
  output: WorkspaceOutput,
  signal?: AbortSignal,
): WorkspaceOperation {
  return {
    cwd: ctx.cwd,
    env: ctx.env,
    output,
    commands: ctx.workspaceCommands ?? defaultCommands,
    invocation: ctx.workspaceInvocation ?? {
      executable: process.execPath,
      entryPoint: fileURLToPath(new URL("../../bin/alignfirst.mjs", import.meta.url)),
    },
    host: alignfirstWorkspaceHost(ctx, output, signal),
  };
}

/** Direct layout/work-files services; no report subprocess and no companion writes. */
function alignfirstWorkspaceHost(
  ctx: CommandContext,
  output: WorkspaceOutput,
  signal?: AbortSignal,
): WorkspaceHost {
  const layouts = new Map<string, ProjectLayout>();
  const callerRoot = canonicalPath(projectRoot(ctx.cwd));
  const layoutFor = (worktree: string): ProjectLayout => {
    const key = canonicalPath(worktree);
    let layout = layouts.get(key);
    if (layout === undefined) {
      layout =
        key === callerRoot && ctx.layout !== undefined
          ? ctx.layout
          : resolveProjectLayout(worktree, ctx.home);
      layouts.set(key, layout);
    }
    return layout;
  };
  return {
    assertLifecycleAdmission: () =>
      assertCompanionLifecycleAdmission(ctx.home, layoutFor(callerRoot)),
    loadWorkspace: (worktree) => {
      const layout = layoutFor(worktree);
      const manifest = resolveProjectConfig(layout)?.config;
      assertDistinctDestinations(
        worktree,
        [
          ...(manifest?.workspace?.gitignoredFiles ?? []),
          ...(manifest?.devServer?.runFiles ?? []),
        ].map((entry) => entry.path),
        layout.storage.registryDir,
      );
      return loadRecipe(ctx, worktree, output, signal, layout);
    },
    validateWorkFiles: (worktree) => {
      const layout = layoutFor(worktree);
      resolveProjectConfig(layout);
      const plans = layout.locations[".plans"];
      resolvePlansMode(worktree, plans, ctx.form, ctx.home);
      if (plans.in === "project") {
        try {
          git({ cwd: worktree, env: ctx.env }, "check-ignore", "-q", "--", ".plans");
        } catch {
          throw new CliError(
            `Project-local plans are not ignored: ${plans.path}. Prepare local Git exclusions or shared/companion work files before workspace setup.`,
          );
        }
      }
    },
    sharedDirectoryProtection: (worktree) => {
      const layout = layoutFor(worktree);
      resolveProjectConfig(layout);
      const paths = [layout.locations[".plans"], layout.locations._aligndev]
        .filter((location) => location.exists)
        .flatMap((location) => existingProtectionPath(location.path));
      if (layout.companion) paths.push(canonicalPath(layout.companion.dir));
      const manifest = resolveProjectConfig(layout)?.config;
      const { mainWorktree } = detectWorktree(worktree);
      for (const directory of manifest?.workspace?.sharedDirs ?? [])
        paths.push(...existingProtectionPath(resolve(mainWorktree, directory)));
      return {
        plans: layout.locations[".plans"],
        protectedPaths: paths,
      };
    },
  };
}

function existingProtectionPath(path: string): string[] {
  try {
    return [realpathSync(path)];
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    )
      return [];
    throw error;
  }
}

function loadRecipe(
  ctx: CommandContext,
  worktree: string,
  output: WorkspaceOutput,
  signal?: AbortSignal,
  layout = resolveProjectLayout(worktree, ctx.home),
): WorkspaceConfig {
  const { mainWorktree } = detectWorktree(worktree);
  const manifest = resolveProjectConfig(layout)?.config;
  const recipe = selectedRecipe(layout);
  const adapted = adaptWorkspaceManifest(manifest ?? {}, {
    recipe,
    mainWorktree,
    configurationDir:
      manifest === undefined ? undefined : dirname(layout.locations.alignfirst.path),
    companionDir: layout.companion?.dir,
    storage: layout.storage,
    env: ctx.env,
    output,
    signal,
  });
  return {
    ...adapted.workspace,
    recipe,
    settings: manifest ?? {},
    configurationDir:
      manifest === undefined ? undefined : dirname(layout.locations.alignfirst.path),
    companionDir: layout.companion?.dir,
    storage: layout.storage,
    hasDevServer: adapted.devServer !== undefined,
  };
}

function selectedRecipe(layout: ProjectLayout): WorkspaceRecipe {
  const config = resolveProjectConfig(layout)?.config;
  if (config?.workspace === undefined && config?.devServer === undefined)
    return { kind: "defaults" };
  const location = layout.locations.alignfirst;
  return {
    kind: "manifest",
    file: location.path.endsWith(".jsonc") ? "alignfirst.jsonc" : "alignfirst.json",
    in: location.in,
  };
}

function assertRegisteredRecipe(
  worktree: string,
  recipe: WorkspaceRecipe,
  registryDir: string,
): void {
  const root = detectWorktree(worktree);
  const found = findWorkspaceByPath(
    readWorkspaces(root.mainWorktree, registryDir),
    root.currentWorktree,
  );
  if (found) assertWorkspaceRecipe(root.currentWorktree, found.entry.recipe, recipe);
}

function workspaceOutput(ctx: CommandContext, json: boolean): WorkspaceOutput {
  const stream = json ? ctx.stderr : ctx.stdout;
  return {
    text: (message) => {
      if (message !== "") stream.write(`${message}\n`);
    },
    diagnostic: (message) => ctx.stderr.write(`${message}\n`),
    write: (text) => stream.write(text),
    isTTY: !json && process.stdout.isTTY === true,
  };
}

function workspaceCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  if (error instanceof ConfigError || error instanceof WorkspaceError || error instanceof Error)
    return new CliError(error.message);
  return new CliError(String(error));
}
