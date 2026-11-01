import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";

const children = new WeakMap<ChildProcessWithoutNullStreams, ChildSettlement>();

interface ChildSettlement {
  closed: boolean;
  error?: Error;
  done: Promise<void>;
  descendants: ProcessIdentity[];
}

interface ProcessIdentity {
  pid: number;
  started: string;
}

export function observeGateway(gateway: ChildProcessWithoutNullStreams): void {
  const settlement: ChildSettlement = { closed: false, done: Promise.resolve(), descendants: [] };
  settlement.done = new Promise<void>((resolve) => {
    gateway.once("error", (error) => {
      settlement.error = error;
    });
    gateway.once("close", () => {
      settlement.closed = true;
      resolve();
    });
  });
  children.set(gateway, settlement);
}

export async function killGateway(
  gateway: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): Promise<void> {
  const settlement = children.get(gateway);
  if (!settlement) throw new Error("Gateway process has no close observer");
  const failures: unknown[] = [];
  const attempt = async (operation: () => void | Promise<void>) => {
    try {
      await operation();
    } catch (error) {
      failures.push(error);
    }
  };
  if (!settlement.closed && gateway.exitCode === null && gateway.signalCode === null) {
    await attempt(async () => {
      settlement.descendants = await readChildPids(gateway.pid);
    });
    await attempt(() => signalGateway(gateway, signal));
  }
  if (!(await within(settlement.done, 5_000))) {
    await attempt(() => signalGateway(gateway, "SIGKILL"));
    if (!(await within(settlement.done, 5_000)))
      failures.push(new Error("Gateway did not close after SIGKILL"));
  }
  await attempt(async () => {
    const survivors = await waitForProcessExit(settlement.descendants, 5_000);
    for (const identity of survivors) {
      await attempt(async () => {
        if (!(await processExists(identity))) return;
        try {
          process.kill(identity.pid, "SIGKILL");
        } catch (error) {
          if (!hasCode(error, "ESRCH")) throw error;
        }
      });
    }
    const remaining = await waitForProcessExit(survivors, 5_000);
    if (remaining.length > 0)
      throw new Error(
        `Owned gateway descendants remain: ${remaining.map((identity) => identity.pid).join(", ")}`,
      );
  });
  if (settlement.error) failures.push(settlement.error);
  if (failures.length > 0) throw new AggregateError(failures, "Gateway shutdown failed");
}

function signalGateway(gateway: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (gateway.exitCode !== null || gateway.signalCode !== null) return;
  try {
    gateway.kill(signal);
  } catch (error) {
    if (!hasCode(error, "ESRCH")) throw error;
  }
}

async function readChildPids(parentPid: number | undefined): Promise<ProcessIdentity[]> {
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
    owned.push({ pid, started: stat.started }, ...(await readChildPids(pid)));
  }
  return owned;
}

async function waitForProcessExit(
  identities: ProcessIdentity[],
  timeoutMs: number,
): Promise<ProcessIdentity[]> {
  const deadline = Date.now() + timeoutMs;
  let remaining = identities;
  do {
    const live = await Promise.all(remaining.map(processExists));
    remaining = remaining.filter((_, index) => live[index]);
    if (remaining.length === 0) return [];
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
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
