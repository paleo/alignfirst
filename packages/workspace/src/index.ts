import {
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
  FinalizeResult,
  SummaryContext,
  PatchContext,
  GitignoredFileEntry,
  GitignoredFileSource,
  MainWorktreeSource,
  CommittedSource,
  ContentSource,
  PurgeContext,
} from "./workspace.js";
export type { PortsConfig, PortComputeContext } from "./ports.js";

export { runDevServer } from "./dev-server.js";
export type {
  DevServerConfig,
  DevServerSummaryContext,
  ServerDescriptor,
  ServerContext,
  SpawnServer,
  CallbackServer,
} from "./dev-server.js";

export type { ResolvedWorkspace } from "./workspaces.js";

export const helpers = {
  patchEnvFile,
  extractHost,
  readPortFromEnvFile,
  readPortFromJsonFile,
  detectCommonJsError,
};

export { StartupError, ConfigError, WorkspaceError } from "./errors.js";
