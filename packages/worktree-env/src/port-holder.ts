import { execSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { createConnection } from "node:net";
import { platform } from "node:os";

import { stopProcessGroup } from "./process-control.js";
import type { ServerDescriptor, SpawnServer } from "./server-descriptor.js";

export interface PortHolder {
  pid: number;
  /** Process group id. Absent when `ps` output couldn't be parsed; callers must skip group kills. */
  pgid?: number;
  cmd: string;
  cwd?: string;
}

export type PortConflict =
  | { kind: "ours"; server: SpawnServer; holder: PortHolder }
  | { kind: "foreign"; server: SpawnServer; holder?: PortHolder };

export function canonicalCwd(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    return cwd;
  }
}

export function findPortHolder(port: number): PortHolder | undefined {
  if (platform() === "win32") return;
  const pid = listenerPid(port);
  if (pid === undefined) return;
  const psInfo = pidPgidAndCommand(pid);
  const cwd = pidCwd(pid);
  return { pid, pgid: psInfo?.pgid, cmd: psInfo?.cmd ?? "", cwd };
}

export function isPidOurs(holder: PortHolder, ourCanonicalCwd: string): boolean {
  if (holder.cwd === undefined) return false;
  const holderCwd = canonicalCwd(holder.cwd);
  return holderCwd === ourCanonicalCwd || holderCwd.startsWith(`${ourCanonicalCwd}/`);
}

export function isPortBusy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    socket.setTimeout(500);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      resolve(false);
    });
  });
}

export async function detectPortConflicts(
  servers: ServerDescriptor[],
  ourCanonicalCwd: string,
): Promise<PortConflict[]> {
  const conflicts: PortConflict[] = [];
  for (const server of spawnServersOf(servers)) {
    if (!(await isPortBusy(server.port))) continue;
    const holder = findPortHolder(server.port);
    if (holder && isPidOurs(holder, ourCanonicalCwd)) {
      conflicts.push({ kind: "ours", server, holder });
    } else {
      conflicts.push({ kind: "foreign", server, holder });
    }
  }
  return conflicts;
}

/** Polls the given ports until all are free or `timeoutMs` elapses. Returns ports still busy. */
export async function waitForPortsFree(ports: number[], timeoutMs: number): Promise<number[]> {
  const intervalMs = 100;
  const deadline = Date.now() + timeoutMs;
  let pending = [...ports];
  while (pending.length > 0) {
    const results = await Promise.all(pending.map(async (p) => ({ p, busy: await isPortBusy(p) })));
    pending = results.filter((r) => r.busy).map((r) => r.p);
    if (pending.length === 0 || Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return pending;
}

export async function sweepStalePorts(servers: ServerDescriptor[], cwd: string): Promise<void> {
  if (platform() === "win32") return;
  const ourCwd = canonicalCwd(cwd);
  for (const server of spawnServersOf(servers)) {
    await sweepOnePort(server, ourCwd);
  }
}

function spawnServersOf(servers: ServerDescriptor[]): SpawnServer[] {
  return servers.filter((s): s is SpawnServer => s.kind === "spawn");
}

async function sweepOnePort(server: SpawnServer, ourCanonicalCwd: string): Promise<void> {
  const holder = findPortHolder(server.port);
  if (holder === undefined) return;
  if (isPidOurs(holder, ourCanonicalCwd)) {
    if (holder.pgid === undefined) {
      console.warn(
        `Leaked ${server.name} on port ${server.port} (PID ${holder.pid}: ${holder.cmd}); pgid unknown, left untouched.`,
      );
      return;
    }
    console.warn(
      `Sweeping leaked ${server.name} on port ${server.port} (PID ${holder.pid}: ${holder.cmd}).`,
    );
    await stopProcessGroup(holder.pgid);
  } else {
    const cwdPart = holder.cwd ? ` (cwd ${holder.cwd})` : "";
    console.warn(
      `Port ${server.port} (${server.name}) still in use by PID ${holder.pid}: ${holder.cmd}${cwdPart}. Left untouched.`,
    );
  }
}

function listenerPid(port: number): number | undefined {
  const out = tryExec(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`);
  if (out === undefined) return;
  const trimmed = out.trim();
  if (trimmed === "") return;
  const pid = Number(trimmed.split(/\s+/)[0]);
  return Number.isFinite(pid) ? pid : undefined;
}

function pidPgidAndCommand(pid: number): { pgid: number; cmd: string } | undefined {
  const out = tryExec(`ps -p ${pid} -o pgid=,command=`);
  if (out === undefined) return;
  const match = out.trim().match(/^(\d+)\s+(.+)$/);
  if (match === null) return;
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed)) return;
  return { pgid: parsed, cmd: match[2] };
}

function pidCwd(pid: number): string | undefined {
  const out = tryExec(`lsof -p ${pid} -a -d cwd -Fn`);
  if (out === undefined) return;
  const match = out.match(/^n(.+)$/m);
  return match === null ? undefined : match[1];
}

function tryExec(command: string): string | undefined {
  try {
    return execSync(command, { stdio: ["ignore", "pipe", "ignore"] }).toString();
  } catch {
    return;
  }
}
