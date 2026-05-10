import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { StartupError } from "./errors.js";
import { isProcessAlive as defaultIsAlive } from "./process-control.js";

export const LOG_TAIL_LINES = 30;
export const POLL_INTERVAL_MS = 500;
export const TIMEOUT_MS = 120_000;

export interface PollableServer {
  name: string;
  logFile: string;
  detectSuccess: (logContent: string) => boolean;
  detectError?: (logContent: string) => string | false;
}

export interface AwaitOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  isAlive?: (pid: number) => boolean;
}

export async function waitForReady(
  server: PollableServer,
  pid: number,
  options: AwaitOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const isAlive = options.isAlive ?? defaultIsAlive;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      throw new StartupError(server.name, "process exited unexpectedly", server.logFile);
    }

    if (existsSync(server.logFile)) {
      const logContent = readFileSync(server.logFile, "utf-8");
      if (server.detectSuccess(logContent)) return;
      const matched = server.detectError?.(logContent);
      if (matched) {
        throw new StartupError(server.name, `error detected (${matched})`, server.logFile);
      }
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  throw new StartupError(
    server.name,
    `did not become ready within ${timeoutMs / 1000}s`,
    server.logFile,
  );
}

export async function awaitAllReady(
  servers: PollableServer[],
  pids: number[],
  options?: AwaitOptions,
): Promise<void> {
  await Promise.all(servers.map((server, i) => waitForReady(server, pids[i], options)));
}

export function handleStartupFailure(err: StartupError): void {
  console.error(`\nError: ${err.label} ${err.reason}.`);
  if (err.logFile && existsSync(err.logFile)) {
    const lines = readFileSync(err.logFile, "utf-8").split("\n").slice(-LOG_TAIL_LINES);
    console.error(`\n--- ${err.label} log tail (last ${LOG_TAIL_LINES} lines) ---`);
    console.error(lines.join("\n"));
    console.error(`--- end ---\nFull log: ${join(process.cwd(), err.logFile)}`);
  }
}
