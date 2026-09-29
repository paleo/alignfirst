import { spawnSync } from "node:child_process";

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
    throw new Error(
      "alignfirst is not installed. Install it globally (`npm install -g alignfirst`), or run " +
        "aldev through npx (`npx -y aldev`).",
    );
  }
  if (result.error) throw result.error;
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export function reserveSideTicket(command: string[], cwd: string, env: NodeJS.ProcessEnv): string {
  const result = runAlignfirst(command, ["ticket", "--side", "--json"], cwd, env);
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "alignfirst ticket --side failed");
  }
  const report: unknown = JSON.parse(result.stdout);
  if (!isRecord(report) || typeof report.TICKET_ID !== "string") {
    throw new Error("alignfirst ticket --side returned an invalid JSON report");
  }
  return report.TICKET_ID;
}

// Creates or restores the ticket's directories, as `alignfirst ticket <id>` does for a developer.
export function openTicket(
  command: string[],
  cwd: string,
  ticket: string,
  env: NodeJS.ProcessEnv,
): void {
  const result = runAlignfirst(command, ["ticket", ticket, "--json"], cwd, env);
  if (result.status !== 0) throw new Error(result.stderr.trim() || "alignfirst ticket failed");
}

export function loadCatchup(
  command: string[],
  cwd: string,
  ticket: string,
  env: NodeJS.ProcessEnv,
): string {
  const result = runAlignfirst(command, ["ticket", ticket, "--catchup"], cwd, env);
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "alignfirst ticket --catchup failed");
  }
  return result.stdout;
}

export function loadContext(command: string[], cwd: string, env: NodeJS.ProcessEnv): string {
  const result = runAlignfirst(command, ["context"], cwd, env);
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "alignfirst context failed");
  }
  return result.stdout;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isErrnoException(error: Error): error is NodeJS.ErrnoException {
  return "code" in error;
}
