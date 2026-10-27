import { spawn } from "node:child_process";

import { WorkspaceError } from "./errors.js";
import { stopProcessGroup } from "./process-control.js";
import type { WorkspaceOutput } from "./operation.js";
import type { ResolvedCommand } from "./script-context.js";

export interface ExecuteCommandOptions {
  signal?: AbortSignal;
  stdin?: string;
  stdout?: "capture" | "stream";
  label: string;
  output?: WorkspaceOutput;
}

/** Resolves only after close (including output draining) and cancellation cleanup. */
export async function executeCommand(
  command: ResolvedCommand,
  options: ExecuteCommandOptions,
): Promise<string> {
  options.signal?.throwIfAborted();
  const child = spawn(command.command, command.args, {
    cwd: command.cwd,
    env: command.env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let launchError: Error | undefined;
  let inputError: Error | undefined;
  let stopping: Promise<void> | undefined;
  const abort = (): void => {
    if (child.pid !== undefined) stopping ??= stopProcessGroup(child.pid, 1000);
  };
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    if (options.output) options.output.diagnostic(chunk.trimEnd());
    else process.stderr.write(chunk);
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (options.stdout === "stream") {
      if (options.output) options.output.write(chunk);
      else process.stdout.write(chunk);
    } else output += chunk;
  });
  child.on("error", (error) => {
    launchError = error;
  });
  child.stdin.on("error", (error: NodeJS.ErrnoException) => {
    // A failing child can close stdin before its exit status is available.
    if (error.code !== "EPIPE") inputError = error;
  });
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  child.stdin.end(options.stdin);
  try {
    const result = await closed;
    await stopping;
    options.signal?.throwIfAborted();
    if (launchError || inputError) {
      // Never include argv/env: either can contain interpolated secrets.
      throw new WorkspaceError(`${options.label}: command launch/input failed.`, {
        cause: launchError ?? inputError,
      });
    }
    if (result.signal !== null)
      throw new WorkspaceError(`${options.label}: terminated by ${result.signal}.`);
    if (result.code !== 0)
      throw new WorkspaceError(`${options.label}: exited with code ${result.code}.`);
    return output;
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
}
