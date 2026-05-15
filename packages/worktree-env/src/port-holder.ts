import { execSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { platform } from "node:os";

import { stopProcessGroup } from "./process-control.js";
import type { ServerDescriptor, SpawnServer } from "./server-descriptor.js";

export interface PortHolder {
  pid: number;
  pgid: number;
  cmd: string;
  cwd?: string;
}

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
  const { pgid, cmd } = pidPgidAndCommand(pid);
  const cwd = pidCwd(pid);
  return { pid, pgid, cmd, cwd };
}

export function isPidOurs(holder: PortHolder, ourCanonicalCwd: string): boolean {
  if (holder.cwd === undefined) return false;
  const holderCwd = canonicalCwd(holder.cwd);
  return holderCwd === ourCanonicalCwd || holderCwd.startsWith(`${ourCanonicalCwd}/`);
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

function pidPgidAndCommand(pid: number): { pgid: number; cmd: string } {
  const out = tryExec(`ps -p ${pid} -o pgid=,command=`);
  if (out === undefined) return { pgid: pid, cmd: "" };
  const match = out.trim().match(/^(\d+)\s+(.+)$/);
  if (match === null) return { pgid: pid, cmd: "" };
  const parsed = Number(match[1]);
  const pgid = Number.isFinite(parsed) ? parsed : pid;
  return { pgid, cmd: match[2] };
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
