import { existsSync, readFileSync, unlinkSync } from "node:fs";

export async function stopByPidFile(
  pidFile: string,
  label: string,
  log: (msg: string) => void = () => {},
): Promise<void> {
  const pid = readPid(pidFile);
  if (pid === undefined || !isProcessAlive(pid)) {
    cleanupPidFile(pidFile);
    log(`No ${label} process is running.`);
    return;
  }
  log(`Stopping ${label} (PID ${pid})...`);
  await stopProcessGroup(pid);
  cleanupPidFile(pidFile);
  log(`${label} stopped.`);
}

export async function stopProcessGroup(pid: number, timeoutMs = 10_000): Promise<void> {
  killProcessGroup(pid, "SIGTERM");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    if (!isProcessGroupAlive(pid)) return;
  }
  killProcessGroup(pid, "SIGKILL");
}

export function readPid(pidFile: string): number | undefined {
  if (!existsSync(pidFile)) return undefined;
  const raw = readFileSync(pidFile, "utf-8").trim();
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  return pid;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already dead
    }
  }
}

export function cleanupPidFile(pidFile: string): void {
  if (existsSync(pidFile)) unlinkSync(pidFile);
}
