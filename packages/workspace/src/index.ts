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
export { resolveServers } from "./server-descriptor.js";
export type {
  ResolvedServerDescriptor,
  ResolvedSpawnServer,
  SpawnCommand,
} from "./server-descriptor.js";
export { runWorkspace } from "./workspace.js";
export { defaultWorktreeDirName } from "./worktree.js";
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
