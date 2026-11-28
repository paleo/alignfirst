import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";

const children = new WeakMap<ChildProcessWithoutNullStreams, ChildSettlement>();

interface ChildSettlement {
  error?: Error;
  exited: Promise<void>;
}

interface ProcessIdentity {
  pid: number;
  started: string;
}

export function observeGateway(gateway: ChildProcessWithoutNullStreams): void {
  const settlement: ChildSettlement = { exited: Promise.resolve() };
  settlement.exited = new Promise<void>((resolve) => {
    gateway.once("error", (error) => {
      settlement.error = error;
    });
    gateway.once("exit", () => resolve());
  });
  children.set(gateway, settlement);
}

/**
 * Kills the gateway and every descendant at once. It waits for `exit`, not `close`: a descendant
 * holding the inherited stdio pipes (OpenClaw's launcher respawns the gateway) would delay `close`.
 */
export async function killGateway(gateway: ChildProcessWithoutNullStreams): Promise<void> {
  const settlement = children.get(gateway);
  if (!settlement) throw new Error("Gateway process has no exit observer");
  const failures: unknown[] = [];
  let tree: ProcessIdentity[] = [];
  if (gateway.exitCode === null && gateway.signalCode === null) {
    try {
      tree = await readProcessTree(gateway.pid);
    } catch (error) {
      failures.push(error);
    }
    for (const pid of [gateway.pid, ...tree.map((identity) => identity.pid)]) {
      try {
        if (pid !== undefined) process.kill(pid, "SIGKILL");
      } catch (error) {
        if (!hasCode(error, "ESRCH")) failures.push(error);
      }
    }
  }
  if (!(await within(settlement.exited, 10_000)))
    failures.push(new Error("Gateway did not exit after SIGKILL"));
  const remaining = await waitForProcessExit(tree, 10_000);
  if (remaining.length > 0)
    failures.push(
      new Error(
        `Gateway descendants remain: ${remaining.map((identity) => identity.pid).join(", ")}`,
      ),
    );
  if (settlement.error) failures.push(settlement.error);
  if (failures.length > 0) throw new AggregateError(failures, "Gateway shutdown failed");
}

async function readProcessTree(parentPid: number | undefined): Promise<ProcessIdentity[]> {
  if (parentPid === undefined) return [];
  let contents: string;
  try {
    contents = await readFile(`/proc/${parentPid}/task/${parentPid}/children`, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT") || hasCode(error, "ESRCH")) return [];
    throw error;
  }
  const owned: ProcessIdentity[] = [];
  for (const value of contents
    .trim()
    .split(/\s+/u)
    .filter((value) => value.length > 0)) {
    const pid = Number(value);
    const stat = await processStat(pid);
    if (!stat) continue;
    owned.push({ pid, started: stat.started }, ...(await readProcessTree(pid)));
  }
  return owned;
}

async function waitForProcessExit(
  identities: ProcessIdentity[],
  timeoutMs: number,
): Promise<ProcessIdentity[]> {
  const deadline = Date.now() + timeoutMs;
  let remaining = identities;
  while (remaining.length > 0 && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const live = await Promise.all(remaining.map(processExists));
    remaining = remaining.filter((_, index) => live[index]);
  }
  return remaining;
}

async function processExists(identity: ProcessIdentity): Promise<boolean> {
  const stat = await processStat(identity.pid);
  return stat !== undefined && stat.started === identity.started && stat.state !== "Z";
}

async function processStat(pid: number): Promise<{ started: string; state: string } | undefined> {
  try {
    const contents = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = contents.slice(contents.lastIndexOf(")") + 2).split(" ");
    if (fields[19] === undefined || fields[0] === undefined)
      throw new Error(`Malformed process stat: ${pid}`);
    return { started: fields[19], state: fields[0] };
  } catch (error) {
    if (hasCode(error, "ENOENT") || hasCode(error, "ESRCH")) return;
    throw error;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function within(operation: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
