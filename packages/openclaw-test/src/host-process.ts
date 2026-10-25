import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";

export interface HostProcessRequest {
  command: string;
  argv: string[];
  env?: Record<string, string>;
  logFile?: string;
  onChild?: (child: ChildProcess) => void;
}

/** Join the owned command and its output before returning, including signal escalation. */
export function spawnHostProcess(req: HostProcessRequest): Promise<number> {
  return new Promise((resolve) => {
    const logFd = req.logFile === undefined ? undefined : openSync(req.logFile, "a");
    let child: ChildProcess;
    try {
      child = spawn(req.command, req.argv, {
        env: req.env === undefined ? process.env : { ...process.env, ...req.env },
        stdio: logFd === undefined ? "inherit" : ["ignore", logFd, logFd],
        detached: process.platform !== "win32",
      });
    } finally {
      if (logFd !== undefined) closeSync(logFd);
    }
    let escalation: NodeJS.Timeout | undefined;
    let signalExit: number | undefined;
    let spawnFailed = false;
    const onSignal = (signal: NodeJS.Signals) => {
      signalExit ??= signal === "SIGINT" ? 130 : 143;
      killOwned(child, signal);
      escalation ??= setTimeout(() => killOwned(child, "SIGKILL"), 1_000);
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    req.onChild?.(child);
    child.on("error", (error) => {
      spawnFailed = true;
      console.error(error.message);
    });
    child.on("close", (code, signal) => {
      if (escalation !== undefined) killOwned(child, "SIGKILL");
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      clearTimeout(escalation);
      const status = spawnFailed
        ? 1
        : (code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1));
      resolve(signalExit ?? status);
    });
  });
}

function killOwned(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    // The command may have exited before the signal arrived.
  }
}
