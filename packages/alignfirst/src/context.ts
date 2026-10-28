import type { Invocation, InvocationCommand } from "@alignfirst/docmap/invocation";
import type { WorkspaceCommands } from "@alignfirst/workspace";
import type { ResolvedProjectConfig } from "./project-config-types.js";
import type { ProjectLayout } from "./project-layout.js";

export interface Output {
  write(text: string): void;
}

export interface Streams {
  stdout: Output;
  stderr: Output;
}

export interface CommandContext extends Streams {
  workspaceInvocation?: { executable: string; entryPoint: string };
  workspaceCommands?: WorkspaceCommands;
  cwd: string;
  env: NodeJS.ProcessEnv;
  home: string;
  form: string;
  invocation?: Invocation;
  command?: InvocationCommand;
  version: string;
  projectConfig?: ResolvedProjectConfig;
  layout?: ProjectLayout;
}
