import {
  composeProjectName,
  detectCommonJsError,
  extractHost,
  patchEnvFile,
  readPortFromEnvFile,
  readPortFromJsonFile,
} from "./helpers.js";

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
  ServerDescriptor,
  ServerContext,
  SpawnServer,
  CallbackServer,
} from "./dev-server.js";
export type { DevSetupContext } from "./dev-setup.js";
export type { DevPortsConfig, PortRange } from "./ports.js";

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
