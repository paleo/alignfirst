import {
  composeProjectName,
  detectCommonJsError,
  extractHost,
  patchEnvFile,
  readPortFromEnvFile,
  readPortFromJsonFile,
} from "./helpers.js";

export {
  configFamilyExists,
  resolveConfigFamily,
  readConfigFile,
  validateConfigSchema,
  loadWorkspaceManifest,
  validateWorkspaceManifest,
  readWorkspaceConfigReport,
  WORKSPACE_CONFIG_FAMILY,
} from "./config.js";
export type {
  WorkspaceManifest,
  WorkspaceSettings,
  DevSettings,
  FileEntry,
  TextOutput,
  Command,
  Step,
  PurgeStep,
  Server,
  ConfigFileLocation,
  WorkspaceConfigReport,
} from "./config.js";
export { adaptWorkspaceManifest } from "./manifest-adapter.js";
export type { ManifestAdapters, ManifestAdapterOptions } from "./manifest-adapter.js";
export { executeCommand } from "./command-executor.js";
export type { ExecuteCommandOptions } from "./command-executor.js";
export { scriptContext, interpolate, resolveCommand } from "./script-context.js";
export type {
  ScriptContext,
  ScriptContextFields,
  ScriptPhase,
  ScriptServerResult,
  ResolvedCommand,
} from "./script-context.js";
export { assertDistinctDestinations } from "./file-destinations.js";
export { validateRuntimeStorage } from "./preparation.js";
export { resolveServers } from "./server-descriptor.js";
export type {
  ResolvedServerDescriptor,
  ResolvedSpawnServer,
  SpawnCommand,
} from "./server-descriptor.js";
export { readWorkspaceInventory, selectWorkspaceRecord } from "./inventory.js";
export type { WorkspaceInventory, WorkspaceRecord } from "./inventory.js";
export { runWorkspace } from "./workspace.js";
export type { WorkspaceOutcome } from "./workspace.js";
export { parseWorkspaceArgs, parseDevArgs, renderWorkspaceHelp, renderDevHelp } from "./cli.js";
export type {
  WorkspaceCommand,
  WorkspaceSelector,
  ParsedWorkspaceArgs,
  DevCommand,
} from "./cli.js";
export { renderWorkspaceCommands, installedCliCommand, defaultCommands } from "./invocation.js";
export type { InstalledCliInvocation, WorkspaceCommands } from "./invocation.js";
export { consoleWorkspaceOutput } from "./operation.js";
export type {
  WorkspaceOperation,
  WorkspaceOutput,
  WorkspaceHost,
  SharedDirectoryProtection,
} from "./operation.js";
export {
  readWorkspaces,
  updateWorkspaces,
  registerWorkspace,
  findWorkspaceByPath,
  allocateWorkspaceName,
  registryDirFor,
  markWorkspaceReady,
  markWorkspaceFailed,
  workspaceRecipe,
  assertWorkspaceRecipe,
  assertWorkspaceCleanupComplete,
} from "./workspaces.js";
export type {
  WorkspacesRegistry,
  WorkspaceEntry,
  WorkspaceRecipe,
  WorkspaceStatus,
  RunFilesBasis,
} from "./workspaces.js";
export {
  readDevServers,
  findOwnEntry,
  hasLiveSpawnPids,
  liveDevServers,
  liveWorktrees,
  markDevServerCleanupPending,
  completeDevServerCleanup,
  assertNoPendingCleanup,
  updateDevServers,
  registerDevServer,
  pruneAndPersist,
} from "./dev-servers-registry.js";
export type { DevServerEntry, DevServersData } from "./dev-servers-registry.js";
export { defaultWorktreeDirName, detectWorktree } from "./worktree.js";
export type { WorktreeDirNameFn } from "./worktree.js";
export type {
  WorkspaceConfig,
  PreSetupContext,
  FinalizeContext,
  SummaryContext,
  PurgeContext,
} from "./workspace.js";
export type {
  SetupContextBase,
  PatchContext,
  GitignoredFileEntry,
  GitignoredFileSource,
  MainWorktreeSource,
  CommittedSource,
  ContentSource,
  RunFileEntry,
  RunFileContext,
} from "./file-entries.js";

export { assertRegistryOwnership } from "./registry-ownership.js";
export { runDevServer } from "./dev-server.js";
export type {
  DevServerConfig,
  DevServerSummaryContext,
  DevSummaryFormatter,
  ServerDescriptor,
  ServerContext,
  SpawnServer,
  CallbackServer,
} from "./dev-server.js";
export type { DevSetupContext, RunFilesInputsProvider } from "./dev-setup.js";
export type { DeclaredPort, DevPortsConfig, PortRange } from "./ports.js";

export type { ResolvedWorkspace } from "./workspaces.js";

export const helpers = {
  patchEnvFile,
  extractHost,
  composeProjectName,
  readPortFromEnvFile,
  readPortFromJsonFile,
  detectCommonJsError,
};

export { StartupError, ConfigError, WorkspaceError } from "./errors.js";
