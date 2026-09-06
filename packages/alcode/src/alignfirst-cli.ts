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

export function reserveSideTicket(command: string[], cwd: string): string {
  const result = runAlignfirst(command, ["ticket", "--side", "--json"], cwd);
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "alignfirst ticket --side failed");
  }
  const report: unknown = JSON.parse(result.stdout);
  if (!isRecord(report) || typeof report.id !== "string") {
    throw new Error("alignfirst ticket --side returned an invalid JSON report");
  }
  return report.id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isErrnoException(error: Error): error is NodeJS.ErrnoException {
  return "code" in error;
}
