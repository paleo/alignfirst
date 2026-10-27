import type { InstalledCliInvocation, WorkspaceCommands } from "./invocation.js";
import type { WorkspaceConfig } from "./workspace.js";

export interface WorkspaceOperation {
  cwd: string;
  env: NodeJS.ProcessEnv;
  invocation: InstalledCliInvocation;
  output: WorkspaceOutput;
  commands?: WorkspaceCommands;
  host?: WorkspaceHost;
}

/** Text/progress never shares the host's structured-result channel. Methods accept UTF-8 text. */
export interface WorkspaceOutput {
  text: (message: string) => void;
  diagnostic: (message: string) => void;
  write: (text: string) => void;
  isTTY: boolean;
}

/** AlignFirst supplies these services; the kernel does not discover or spawn its host. */
export interface WorkspaceHost {
  loadWorkspace?: (worktree: string) => WorkspaceConfig;
  validateWorkFiles: (worktree: string) => void | Promise<void>;
  sharedDirectoryProtection: (
    worktree: string,
  ) => SharedDirectoryProtection | Promise<SharedDirectoryProtection>;
}

export interface SharedDirectoryProtection {
  plans: { path: string; in: "project" | "companion" };
  protectedPaths: string[];
}

/** Call at a text CLI boundary; JSON callers should route text/write to stderr instead. */
export function consoleWorkspaceOutput(): WorkspaceOutput {
  return {
    text: (message) => console.log(message),
    diagnostic: (message) => console.error(message),
    write: (text) => process.stdout.write(text),
    isTTY: process.stdout.isTTY ?? false,
  };
}
