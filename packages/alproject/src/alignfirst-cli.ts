import { spawnSync } from "node:child_process";

export const DEFAULT_ALIGNFIRST_COMMAND = ["alignfirst"];

export interface AlignfirstResult {
  status: number;
  stdout: string;
  stderr: string;
}

export function runAlignfirst(
  command: string[],
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): AlignfirstResult {
  const result = spawnSync(command[0], [...command.slice(1), ...args], {
    cwd,
    env,
    encoding: "utf8",
  });
  if (result.error && isErrnoException(result.error) && result.error.code === "ENOENT") {
    throw new Error("alignfirst is not installed. Install it: npm install -g alignfirst");
  }
  if (result.error) throw result.error;
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function isErrnoException(error: Error): error is NodeJS.ErrnoException {
  return "code" in error;
}
