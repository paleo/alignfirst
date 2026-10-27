import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { executeCommand } from "./command-executor.js";
import type {
  Command,
  DevSettings,
  FileEntry,
  PurgeStep,
  Server,
  Step,
  TextOutput,
  WorkspaceManifest,
  WorkspaceSettings,
} from "./config.js";
import type { RunFilesInputsProvider } from "./dev-setup.js";
import type {
  DevServerConfig,
  DevServerSummaryContext,
  DevSummaryFormatter,
} from "./dev-server.js";
import { ConfigError, errorMessage, WorkspaceError } from "./errors.js";
import { assertDistinctDestinations } from "./file-destinations.js";
import type {
  GitignoredFileSource,
  RunFileContext,
  SeededFile,
  SetupContextBase,
} from "./file-entries.js";
import type { WorkspaceOutput } from "./operation.js";
import { patchEnvFile } from "./helpers.js";
import {
  interpolate,
  resolveCommand,
  type ScriptContext,
  type ScriptPhase,
  scriptContext,
} from "./script-context.js";
import type { ServerContext, ServerDescriptor } from "./server-descriptor.js";
import type { PurgeContext, WorkspaceConfig } from "./workspace.js";
import type { WorkspaceRecipe } from "./workspaces.js";

export interface ManifestAdapters {
  workspace: ManifestWorkspaceHooks;
  devServer?: DevServerConfig;
}

type ManifestWorkspaceHooks = Pick<
  WorkspaceConfig,
  | "sharedDirs"
  | "runtimeDir"
  | "gitignoredFiles"
  | "preSetup"
  | "finalizeWorkspace"
  | "purgeInfrastructure"
  | "formatSummary"
  | "signal"
>;

export interface ManifestAdapterOptions {
  mainWorktree: string;
  recipe: WorkspaceRecipe;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  output?: WorkspaceOutput;
}

/** Pure wiring: commands and context lookups stay lazy until their kernel phase. */
export function adaptWorkspaceManifest(
  manifest: WorkspaceManifest,
  options: ManifestAdapterOptions,
): ManifestAdapters {
  const paths = [
    ...(manifest.workspace?.gitignoredFiles ?? []),
    ...(manifest.devServer?.runFiles ?? []),
  ].map((entry) => entry.path);
  return {
    workspace: adaptWorkspace(manifest.workspace ?? {}, paths, options),
    devServer:
      manifest.devServer === undefined ? undefined : adaptDev(manifest.devServer, paths, options),
  };
}

function adaptWorkspace(
  settings: WorkspaceSettings,
  paths: string[],
  options: ManifestAdapterOptions,
): ManifestWorkspaceHooks {
  return {
    runtimeDir: ".local-wt",
    sharedDirs: settings.sharedDirs ?? [],
    signal: options.signal,
    gitignoredFiles: (settings.gitignoredFiles ?? []).map((entry) =>
      adaptFile(entry, false, paths, options),
    ),
    preSetup:
      settings.preSetup === undefined
        ? undefined
        : async (ctx) => {
            await runSteps(
              settings.preSetup ?? [],
              scriptContext(ctx, "preSetup", ctx),
              options,
              ctx.signal,
            );
          },
    finalizeWorkspace:
      settings.finalize === undefined || settings.finalize.length === 0
        ? undefined
        : async (ctx) => {
            await runSteps(
              settings.finalize ?? [],
              scriptContext(ctx, "finalize", ctx),
              options,
              ctx.signal,
              ctx.progress,
            );
          },
    purgeInfrastructure:
      settings.purge === undefined ? undefined : (ctx) => purge(settings.purge ?? [], ctx, options),
    formatSummary: async (ctx) =>
      settings.summary === undefined
        ? [
            `Workspace: ${ctx.name}`,
            `Path: ${ctx.currentWorktree}`,
            `Branch: ${ctx.branch}`,
            `Preparation: ${ctx.status}`,
          ].join("\n")
        : textOutput(
            settings.summary,
            scriptContext(ctx, "workspaceSummary", ctx),
            "workspace.summary",
            options,
            ctx.signal,
          ),
  };
}

async function purge(
  steps: PurgeStep[],
  ctx: PurgeContext,
  options: ManifestAdapterOptions,
): Promise<void> {
  const base = {
    name: ctx.name,
    currentWorktree: ctx.worktree,
    mainWorktree: ctx.mainWorktree,
    isMainWorktree: resolve(ctx.worktree) === resolve(ctx.mainWorktree),
  };
  const executionBase = existsSync(ctx.worktree) ? ctx.worktree : ctx.mainWorktree;
  await runSteps(
    steps,
    scriptContext(base, "purge", ctx),
    options,
    ctx.signal,
    undefined,
    executionBase,
  );
}

function adaptDev(
  dev: DevSettings,
  paths: string[],
  options: ManifestAdapterOptions,
): DevServerConfig {
  return {
    runtimeDir: ".local-wt",
    recipe: options.recipe,
    signal: options.signal,
    ports: dev.ports,
    maxConcurrentDevServers: dev.maxConcurrentDevServers,
    runFiles: (dev.runFiles ?? []).map((entry) =>
      adaptFile<RunFileContext>(entry, true, paths, options),
    ),
    runFilesInputs: adaptInputs(dev.runFilesInputs, options),
    setup:
      dev.setup === undefined
        ? undefined
        : async (ctx) => {
            await runSteps(
              dev.setup ?? [],
              scriptContext(ctx, "devSetup", ctx),
              options,
              ctx.signal,
            );
          },
    servers: dev.servers.map((server) => adaptServer(server, options)),
    formatSummary: adaptDevSummary(dev.summary, options),
  };
}

function adaptInputs(
  inputs: string[] | { command: Command } | undefined,
  options: ManifestAdapterOptions,
): RunFilesInputsProvider | undefined {
  if (inputs === undefined) return;
  return async (ctx) => {
    if (Array.isArray(inputs)) {
      const env = options.env ?? process.env;
      return Object.fromEntries(
        inputs
          .filter((key) => Object.hasOwn(env, key) && env[key] !== undefined)
          .map((key) => [key, env[key]]),
      );
    }
    const output = await commandOutput(
      inputs.command,
      scriptContext(ctx, "runFilesInputs", ctx),
      "devServer.runFilesInputs",
      options,
      ctx.signal,
    );
    let value: unknown;
    try {
      value = JSON.parse(output);
    } catch {
      throw invalidInputs();
    }
    if (
      value === null ||
      Array.isArray(value) ||
      typeof value !== "object" ||
      Object.values(value).some((entry) => typeof entry !== "string")
    )
      throw invalidInputs();
    return Object.fromEntries(Object.entries(value));
  };
}

function invalidInputs(): ConfigError {
  return new ConfigError("devServer.runFilesInputs must output a JSON object of strings.");
}

function adaptServer(server: Server, options: ManifestAdapterOptions): ServerDescriptor {
  if (server.kind === "command")
    return {
      kind: "callback",
      name: server.name,
      start: async (ctx) => {
        await commandOutput(
          server.start,
          serverScriptContext(ctx, "start", options),
          `start ${server.name}`,
          options,
          ctx.signal,
          undefined,
          "stream",
        );
      },
      stop: async (ctx) => {
        if (server.stop === undefined) return;
        await commandOutput(
          server.stop,
          serverScriptContext(ctx, "stop", options),
          `stop ${server.name}`,
          options,
          ctx.signal,
          undefined,
          "stream",
        );
      },
    };
  const ready = new RegExp(server.ready.log);
  const error = server.error === undefined ? undefined : new RegExp(server.error.log);
  return {
    kind: "spawn",
    name: server.name,
    port: server.port,
    exec: (ctx) =>
      resolveCommand(
        server.exec,
        serverScriptContext(ctx, "start", options),
        `servers.${server.name}.exec`,
        undefined,
        options.env,
      ),
    detectReady: (log) => ready.test(log),
    detectError: error === undefined ? undefined : (log) => (error.test(log) ? "error.log" : false),
  };
}

function adaptDevSummary(
  output: TextOutput | undefined,
  options: ManifestAdapterOptions,
): DevSummaryFormatter | undefined {
  if (output === undefined) return;
  return (ctx) =>
    textOutput(output, devSummaryContext(ctx, options), "devServer.summary", options, ctx.signal);
}

function devSummaryContext(
  ctx: DevServerSummaryContext,
  options: ManifestAdapterOptions,
): ScriptContext {
  const base = serverBase(
    { name: ctx.workspace.name, cwd: ctx.workspace.worktree, ports: ctx.ports },
    options,
  );
  return scriptContext(base, "devSummary", {
    ports: ctx.ports,
    servers: ctx.servers.map((result) => ({
      name: result.server.name,
      kind: result.server.kind === "spawn" ? "spawn" : "command",
      ...(result.port === undefined ? {} : { port: result.port }),
      ...(result.pid === undefined ? {} : { pid: result.pid }),
      ...(result.logFile === undefined ? {} : { logFile: result.logFile }),
    })),
  });
}

interface AdapterFileContext extends SetupContextBase {
  ports?: Record<string, number>;
}

function adaptFile<C extends AdapterFileContext>(
  entry: FileEntry,
  runFile: boolean,
  paths: string[],
  options: ManifestAdapterOptions,
): SeededFile<C> {
  const prefix = runFile ? "runFile" : "workspaceFile";
  return {
    path: entry.path,
    optional: entry.optional,
    source: adaptFileSource<C>(entry, `${prefix}Content`, options),
    patch: adaptFilePatch<C>(entry, `${prefix}Patch`, options),
    validateDestination: (ctx) => assertDistinctDestinations(ctx.currentWorktree, paths),
  };
}

function adaptFileSource<C extends AdapterFileContext>(
  entry: FileEntry,
  phase: ScriptPhase,
  options: ManifestAdapterOptions,
): GitignoredFileSource<C> {
  const source = entry.source;
  if (source.kind !== "content") return source;
  return {
    kind: "content",
    content: (ctx) =>
      textOutput(
        source.content,
        fileContext(ctx, phase, entry.path),
        `${phase}.${entry.path}.source`,
        options,
        ctx.signal,
      ),
  };
}

function adaptFilePatch<C extends AdapterFileContext>(
  entry: FileEntry,
  phase: ScriptPhase,
  options: ManifestAdapterOptions,
): ((content: string, ctx: C) => Promise<string>) | undefined {
  const patch = entry.patch;
  if (patch === undefined) return;
  return async (content, ctx) => {
    const current = fileContext(ctx, phase, entry.path);
    const field = `${phase}.${entry.path}.patch`;
    if ("env" in patch)
      return patchEnvFile(
        content,
        Object.fromEntries(
          Object.entries(patch.env).map(([key, value]) => [
            key,
            interpolate(value, current, `${field}.env.${key}`),
          ]),
        ),
      );
    return commandOutput(patch.command, current, field, options, ctx.signal, content);
  };
}

function fileContext(ctx: AdapterFileContext, phase: ScriptPhase, file: string): ScriptContext {
  return scriptContext(ctx, phase, { file, ports: ctx.ports });
}

async function runSteps(
  steps: (Step | PurgeStep)[],
  ctx: ScriptContext,
  options: ManifestAdapterOptions,
  signal?: AbortSignal,
  progress?: (label: string) => void,
  executionBase?: string,
): Promise<void> {
  const failures: Error[] = [];
  for (const step of steps) {
    const activeSignal = invocationSignal(options.signal, signal);
    activeSignal?.throwIfAborted();
    progress?.(step.name);
    try {
      await commandOutput(
        step,
        ctx,
        `${ctx.phase} ${step.name}`,
        options,
        activeSignal,
        undefined,
        "stream",
        executionBase,
      );
    } catch (error) {
      activeSignal?.throwIfAborted();
      const failure =
        error instanceof WorkspaceError || error instanceof ConfigError
          ? error
          : new WorkspaceError(`${ctx.phase} ${step.name}: ${errorMessage(error)}`, {
              cause: error,
            });
      if (ctx.phase !== "purge") throw failure;
      failures.push(failure);
      if (!("continueOnError" in step) || !step.continueOnError) break;
    }
  }
  if (failures.length > 0)
    throw new AggregateError(failures, failures.map((error) => error.message).join("; "));
}

async function textOutput(
  output: TextOutput,
  ctx: ScriptContext,
  field: string,
  options: ManifestAdapterOptions,
  signal?: AbortSignal,
): Promise<string> {
  invocationSignal(options.signal, signal)?.throwIfAborted();
  return typeof output === "string"
    ? interpolate(output, ctx, field)
    : commandOutput(output.command, ctx, field, options, signal);
}

async function commandOutput(
  command: Command,
  ctx: ScriptContext,
  field: string,
  options: ManifestAdapterOptions,
  signal?: AbortSignal,
  stdin?: string,
  stdout: "capture" | "stream" = "capture",
  executionBase?: string,
): Promise<string> {
  return executeCommand(resolveCommand(command, ctx, field, executionBase, options.env), {
    label: field,
    signal: invocationSignal(options.signal, signal),
    stdin,
    stdout,
    output: options.output,
  });
}

function invocationSignal(first?: AbortSignal, second?: AbortSignal): AbortSignal | undefined {
  // An explicit kernel signal may be a fresh rollback/cleanup lifetime.
  return second ?? first;
}

function serverScriptContext(
  ctx: ServerContext,
  phase: "start" | "stop",
  options: ManifestAdapterOptions,
): ScriptContext {
  return scriptContext(serverBase(ctx, options), phase, { ports: ctx.ports });
}

function serverBase(ctx: ServerContext, options: ManifestAdapterOptions): SetupContextBase {
  return {
    name: ctx.name,
    currentWorktree: ctx.cwd,
    mainWorktree: options.mainWorktree,
    isMainWorktree: resolve(ctx.cwd) === resolve(options.mainWorktree),
  };
}
