import { spawn } from "node:child_process";

// Minimal copies of the detached-spawn + liveness helpers from `@paleo/workspace`, duplicated so
// this package stays standalone (no runtime dependency on the workspace package).

export function spawnDetachedNode(scriptPath: string, env: NodeJS.ProcessEnv, cwd: string): number {
  const child = spawn(process.execPath, [scriptPath], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env,
    cwd,
  });
  if (child.pid === undefined) throw new Error("Failed to spawn the alcoach session runner.");
  child.unref();
  return child.pid;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
