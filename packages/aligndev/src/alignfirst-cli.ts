import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { delimiter, resolve, sep } from "node:path";

import { readPackageVersion } from "./package-version.js";

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
        `aligndev through npx (\`npx -y aligndev\`). ${describeAlignfirst(command, cwd, env)}`,
    );
  }
  if (result.error) throw result.error;
  if (result.status === 0) forwardSettingsWarnings(result.stderr);
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

// Forward only recognized settings warnings, leaving other diagnostics to the caller.
export function forwardSettingsWarnings(stderr: string): string {
  const diagnostics: string[] = [];
  for (const line of stderr.split(/\r?\n/)) {
    if (isSettingsWarning(line)) console.warn(line);
    else diagnostics.push(line);
  }
  return diagnostics.join("\n");
}

function isSettingsWarning(line: string): boolean {
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(line)) return false;
  return (
    /^Warning: ignoring unknown (?:\.alignfirst\.json|companion registry) setting /u.test(line) ||
    /^Warning: .+: plans\.folder is deprecated; rename it to plans\.repositoryFolder\. See "Rename the Work-Files Folder Setting" in the setup guide's alignfirst-upgrade reference\.$/u.test(
      line,
    )
  );
}

export function describeAlignfirst(command: string[], cwd: string, env: NodeJS.ProcessEnv): string {
  const npx = command[0] === "npx";
  const reason = npx
    ? "aligndev was launched through npm/npx; npx prefers the project's local alignfirst dependency"
    : "aligndev runs alignfirst from PATH when launched directly";
  const facts = [`\`${command.join(" ")}\` (${reason})`];
  if (!npx) facts.push(describeExecutable(command[0], cwd, env));
  const version = spawnSync(command[0], [...command.slice(1), "--version"], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
  const line = version.stdout?.split(/\r?\n/, 1)[0]?.trim();
  if (version.status === 0 && line !== undefined && line !== "" && line.length <= 80) {
    facts.push(`version ${line}`);
  }
  const entry = process.argv[1] === undefined ? "" : ` at ${process.argv[1]}`;
  facts.push(`aligndev ${readPackageVersion()}${entry}`);
  return `alignfirst: ${facts.join("; ")}`.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ");
}

function describeExecutable(command: string, cwd: string, env: NodeJS.ProcessEnv): string {
  if (command.includes(sep)) {
    return `executable ${command}${existsSync(resolve(cwd, command)) ? "" : " (not found)"}`;
  }
  for (const dir of env.PATH?.split(delimiter) ?? []) {
    const path = resolve(cwd, dir, command);
    try {
      accessSync(path, constants.X_OK);
      if (statSync(path).isFile()) return `executable ${path}`;
    } catch {
      // Continue through PATH when an entry is missing or not executable.
    }
  }
  return "not found on PATH";
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
