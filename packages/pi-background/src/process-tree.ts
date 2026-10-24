import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

const GRACE_MS = 5_000;
const REAP_MS = 2_000;

export interface ManagedProcess {
  child: ChildProcessWithoutNullStreams;
  spawned: Promise<Error | undefined>;
  exited: Promise<ProcessExit>;
  closed: Promise<void>;
  stop: (deadline?: number) => Promise<void>;
}

export interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

export interface LaunchOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdout: (chunk: Buffer) => void;
  stderr: (chunk: Buffer) => void;
  inputError: (error: Error) => void;
}

interface Target {
  pid: number;
  ppid: number;
  group: number;
  identity: string;
  zombie: boolean;
}

export function launchManaged(options: LaunchOptions): ManagedProcess {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    throw new Error(
      "Background process supervision requires Linux, macOS, or Windows through WSL.",
    );
  }
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let acknowledge!: (error?: Error) => void;
  let finish!: (exit: ProcessExit) => void;
  let drain!: () => void;
  const spawned = new Promise<Error | undefined>((resolve) => {
    acknowledge = resolve;
  });
  const exited = new Promise<ProcessExit>((resolve) => {
    finish = resolve;
  });
  const closed = new Promise<void>((resolve) => {
    drain = resolve;
  });
  child.once("spawn", () => acknowledge());
  child.once("error", (error) => {
    acknowledge(error);
    finish({ code: null, signal: null, error });
  });
  child.once("exit", (code, signal) => finish({ code, signal }));
  child.once("close", () => drain());
  child.stdout.on("data", options.stdout);
  child.stderr.on("data", options.stderr);
  child.stdout.on("error", options.inputError);
  child.stderr.on("error", options.inputError);
  child.stdin.on("error", options.inputError);
  const targets = new Map<number, Target>();
  const groups = new Set<number>();
  if (child.pid !== undefined) groups.add(child.pid);
  let cleanup: Promise<void> | undefined;
  let complete = false;
  const managed: ManagedProcess = {
    child,
    spawned,
    exited,
    closed,
    stop(deadline = Date.now() + GRACE_MS) {
      if (cleanup) return cleanup;
      if (complete) return Promise.resolve();
      cleanup = terminate(managed, targets, groups, deadline)
        .then(() => {
          complete = true;
        })
        .finally(() => {
          cleanup = undefined;
        });
      return cleanup;
    },
  };
  return managed;
}

async function terminate(
  managed: ManagedProcess,
  targets: Map<number, Target>,
  groups: Set<number>,
  deadline: number,
): Promise<void> {
  const spawnError = await managed.spawned;
  if (spawnError) {
    await within(managed.closed, REAP_MS, "spawn-failure pipe cleanup");
    return;
  }
  await refreshTargets(managed, targets, groups);
  signalTargets(targets, "SIGTERM");
  await untilExitOrDeadline(managed.exited, deadline);
  await refreshTargets(managed, targets, groups);
  if (targets.size > 0 && Date.now() < deadline) await delay(deadline - Date.now());
  await refreshTargets(managed, targets, groups);
  signalTargets(targets, "SIGKILL");
  await within(managed.exited, REAP_MS, "direct-child reaping");
  await within(managed.closed, REAP_MS, "pipe cleanup");
  // SIGKILL delivery is asynchronous; one bounded wait is not a process scanner.
  if (targets.size > 0) await delay(50);
  await refreshTargets(managed, targets, groups);
  if (targets.size > 0) {
    throw new Error(`Background cleanup could not confirm exit: ${[...targets.keys()].join(", ")}`);
  }
}

async function refreshTargets(
  managed: ManagedProcess,
  targets: Map<number, Target>,
  groups: Set<number>,
): Promise<void> {
  const table = await processTable();
  const live = new Map(
    table.filter((target) => !target.zombie).map((target) => [target.pid, target]),
  );
  for (const [pid, target] of targets) {
    if (live.get(pid)?.identity !== target.identity) targets.delete(pid);
  }
  const liveGroups = new Set([...live.values()].map((target) => target.group));
  for (const group of groups) if (!liveGroups.has(group)) groups.delete(group);
  const leader = managed.child.pid;
  if (leader === undefined) return;
  const own = new Set(targets.keys());
  for (const target of live.values()) {
    const directChild =
      target.pid === leader && managed.child.exitCode === null && managed.child.signalCode === null;
    if (directChild || groups.has(target.group)) own.add(target.pid);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const target of live.values()) {
      if (!own.has(target.pid) && own.has(target.ppid)) {
        own.add(target.pid);
        changed = true;
      }
    }
  }
  for (const pid of own) {
    const target = live.get(pid);
    if (!target) continue;
    if (pid <= 1 || pid === process.pid) throw new Error("Unsafe background cleanup target.");
    targets.set(pid, target);
    if (target.group === target.pid) groups.add(target.group);
  }
}

async function processTable(): Promise<Target[]> {
  if (process.platform === "linux") return linuxProcessTable();
  return psProcessTable();
}

function linuxProcessTable(): Target[] {
  return readdirSync("/proc")
    .filter((name) => /^\d+$/.test(name))
    .flatMap((name) => {
      const pid = Number(name);
      const fields = readStatFields(pid);
      return fields ? [linuxTarget(pid, fields)] : [];
    });
}

// The fields after the command name, or undefined when the process has vanished.
function readStatFields(pid: number): string[] | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ESRCH")
    )
      return;
    throw error;
  }
}

function linuxTarget(pid: number, fields: string[]): Target {
  const [state, rawParent, rawGroup] = fields;
  const ppid = Number(rawParent);
  const group = Number(rawGroup);
  if (![pid, ppid, group].every(Number.isSafeInteger) || pid < 1 || ppid < 0 || group < 0) {
    throw new Error("Invalid /proc stat.");
  }
  return { pid, ppid, group, identity: statIdentity(fields), zombie: state === "Z" };
}

function statIdentity(fields: string[]): string {
  const identity = fields[19];
  if (identity === undefined || !/^\d+$/.test(identity)) throw new Error("Invalid /proc stat.");
  return identity;
}

async function psProcessTable(): Promise<Target[]> {
  const output = await new Promise<string>((resolve, reject) => {
    execFile(
      "/bin/ps",
      ["-axo", "pid=,ppid=,pgid=,stat=,lstart="],
      {
        timeout: 1_000,
        maxBuffer: 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout) =>
        error ? reject(new Error(`Process query failed: ${error.message}`)) : resolve(stdout),
    );
  });
  return output
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
      if (!match) throw new Error("Invalid process query record.");
      const [, rawPid, rawParent, rawGroup, state, started] = match;
      const pid = Number(rawPid);
      const ppid = Number(rawParent);
      const group = Number(rawGroup);
      if (![pid, ppid, group].every(Number.isSafeInteger) || pid < 1 || ppid < 0 || group < 0) {
        throw new Error("Unsafe process query record.");
      }
      return { pid, ppid, group, identity: started, zombie: state.startsWith("Z") };
    });
}

function linuxIdentity(pid: number): string | undefined {
  const fields = readStatFields(pid);
  return fields && statIdentity(fields);
}

function signalTargets(targets: Map<number, Target>, signal: NodeJS.Signals): void {
  for (const target of targets.values()) {
    if (process.platform === "linux" && linuxIdentity(target.pid) !== target.identity) continue;
    try {
      process.kill(target.pid, signal);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
    }
  }
}

async function untilExitOrDeadline(exited: Promise<ProcessExit>, deadline: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      exited,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function within<T>(promise: Promise<T>, ms: number, description: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out awaiting ${description}.`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
