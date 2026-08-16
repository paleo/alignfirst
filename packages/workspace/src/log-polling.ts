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
  detectReady: (logContent: string) => boolean;
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
      if (server.detectReady(logContent)) return;
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

export interface LogFollower {
  /** Prints any bytes appended since the last poll, then stops following. */
  stop: () => void;
}

/** Streams new bytes appended to `path` to stdout, starting at `initialOffset`. */
export function followLogFile(path: string, prefix: string, initialOffset: number): LogFollower {
  let offset = initialOffset;
  const drain = (): void => {
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
  };
  const timer = setInterval(drain, TAIL_INTERVAL_MS);
  return {
    stop: () => {
      clearInterval(timer);
      drain();
    },
  };
}

/** Prints the last `lines` of the log, then returns the byte offset where {@link followLogFile}
 * resumes (the file's current size). Reads raw bytes so the offset matches the file even if it
 * holds invalid UTF-8, which a decoded string's byte length would not. */
export function replayTail(path: string, prefix: string, lines: number): number {
  if (!existsSync(path)) return 0;
  const buffer = readFileSync(path);
  const tail = lastLines(buffer.toString("utf8"), lines);
  if (tail.length > 0) writeWithPrefix(tail.endsWith("\n") ? tail : `${tail}\n`, prefix);
  return buffer.length;
}

export function writeWithPrefix(text: string, prefix: string): void {
  process.stdout.write(prefix === "" ? text : text.replace(/^(?=.)/gm, prefix));
}
