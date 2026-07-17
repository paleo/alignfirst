import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

import { StartupError } from "./errors.js";
import { lastLines } from "./helpers.js";
import { isProcessAlive as defaultIsAlive } from "./process-control.js";

export const LOG_TAIL_LINES = 30;
export const POLL_INTERVAL_MS = 500;
export const TIMEOUT_MS = 120_000;
export const TAIL_INTERVAL_MS = 300;

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

export async function awaitAllReady(
  servers: PollableServer[],
  pids: number[],
  options?: AwaitOptions,
): Promise<void> {
  await Promise.all(servers.map((server, i) => waitForReady(server, pids[i], options)));
}

export interface StartupFailureOptions {
  /** When false (the foreground already streamed the log live), skip the redundant log tail. */
  includeTail?: boolean;
}

export function handleStartupFailure(err: StartupError, options: StartupFailureOptions = {}): void {
  console.error(`\nError: ${err.label} ${err.reason}.`);
  if (!err.logFile || !existsSync(err.logFile)) return;
  const fullLog = join(process.cwd(), err.logFile);
  if (options.includeTail ?? true) {
    console.error(`\n--- ${err.label} log tail (last ${LOG_TAIL_LINES} lines) ---`);
    console.error(lastLines(readFileSync(err.logFile, "utf-8"), LOG_TAIL_LINES));
    console.error(`--- end ---\nFull log: ${fullLog}`);
    return;
  }
  console.error(`Full log: ${fullLog}`);
}

async function waitForReady(
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

/** Streams new bytes appended to `path` to stdout, starting at `initialOffset`. Returns the poll
 * timer so the caller can stop following. */
export function followLogFile(path: string, prefix: string, initialOffset: number): NodeJS.Timeout {
  let offset = initialOffset;
  return setInterval(() => {
    if (!existsSync(path)) return;
    const size = statSync(path).size;
    if (size < offset) offset = 0;
    if (size <= offset) return;
    const length = size - offset;
    const fd = openSync(path, "r");
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = readSync(fd, buffer, 0, length, offset);
    closeSync(fd);
    offset += bytesRead;
    writeWithPrefix(buffer.subarray(0, bytesRead).toString("utf8"), prefix);
  }, TAIL_INTERVAL_MS);
}

export function writeWithPrefix(text: string, prefix: string): void {
  process.stdout.write(prefix === "" ? text : text.replace(/^(?=.)/gm, prefix));
}
