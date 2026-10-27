import { isAbsolute } from "node:path";
import {
  createCommand,
  type LaunchEvidence,
  packageCommand,
  resolveInvocation,
} from "@alignfirst/docmap/invocation";
import { ConfigError } from "./errors.js";

export const defaultCommands: WorkspaceCommands = {
  workspace: createCommand("alignfirst", ["workspace"]),
  dev: createCommand("alignfirst", ["dev"]),
};

export interface InstalledCliInvocation {
  /** Actual Node/Bun executable, never a package runner. */
  executable: string;
  /** Absolute installed AlignFirst bin path, retained for all internal children. */
  entryPoint: string;
}

export interface WorkspaceCommands {
  workspace: CommandForm;
  dev: CommandForm;
}

export interface CommandForm {
  base: string;
  withArgs: string;
}

/** Public hints only. Internal respawns always use installedCliCommand. */
export function renderWorkspaceCommands(evidence: LaunchEvidence): WorkspaceCommands {
  const target = { packageName: "alignfirst", binaryName: "alignfirst" };
  const command = packageCommand(resolveInvocation(target, evidence), target);
  return {
    workspace: createCommand(command.executable, [...command.args, "workspace"]),
    dev: createCommand(command.executable, [...command.args, "dev"]),
  };
}

export function installedCliCommand(
  invocation: InstalledCliInvocation,
  args: readonly string[],
): { executable: string; args: string[] } {
  if (!isAbsolute(invocation.executable) || !isAbsolute(invocation.entryPoint)) {
    throw new ConfigError(
      "Internal workspace dispatch requires absolute runtime and installed AlignFirst bin paths.",
    );
  }
  return { executable: invocation.executable, args: [invocation.entryPoint, ...args] };
}

export function wsCmd(args: string, commands: WorkspaceCommands = defaultCommands): string {
  return `${commands.workspace.withArgs} ${args}`;
}

export function devCmd(args: string, commands: WorkspaceCommands = defaultCommands): string {
  return `${commands.dev.withArgs} ${args}`;
}
