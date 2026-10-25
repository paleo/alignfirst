import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { DevServerEntry } from "../../src/dev-servers-registry.js";
import type { ServerContext } from "../../src/server-descriptor.js";
import {
  cliExecutable,
  createFixtureRepo,
  type FixtureRepo,
  readWorkspaces,
  runCli,
  runDev,
  writeWorkspaces,
} from "./fixture.js";

const TIMEOUT_MS = 60_000;
const ENV = { E2E_CALLBACK_LIFECYCLE: "1" };
const fixtures: FixtureRepo[] = [];
const children: RunningChild[] = [];
const barriers: string[] = [];

interface Target {
  fx: FixtureRepo;
  root: string;
  nested: string;
  ctx: ServerContext;
}

interface CallbackEvent extends Omit<ServerContext, "name"> {
  name?: string;
  event: string;
  label?: string;
}

interface SpawnEvent {
  pid: number;
  cwd: string;
}

interface RunningChild {
  child: ChildProcess;
  output: string;
  closed: boolean;
}

afterEach(async () => {
  for (const barrier of barriers.splice(0)) writeFileSync(barrier, "release\n");
  const failures: unknown[] = [];
  const ownedChildren = children.splice(0);
  for (const running of ownedChildren) {
    try {
      if (!running.closed) running.child.kill("SIGTERM");
      await waitUntil(() => running.closed, "foreground cleanup");
    } catch (err) {
      failures.push(err);
      running.child.kill("SIGKILL");
      try {
        await waitUntil(() => running.closed, "forced foreground cleanup");
      } catch (killError) {
        failures.push(killError);
      }
    }
  }
  for (const fx of fixtures.splice(0)) {
    const pids = new Set([
      ...spawns(fx).map((event) => event.pid),
      ...devEntries(fx).flatMap((entry) => Object.values(entry.pids)),
    ]);
    for (const pid of pids) {
      try {
        if (isAlive(pid)) process.kill(-pid, "SIGKILL");
        await waitUntil(() => !isAlive(pid), `spawn ${pid} cleanup`);
      } catch (err) {
        failures.push(err);
      }
    }
    for (const entry of Object.values(readWorkspaces(fx.repo).workspaces)) {
      if (entry.status === "pending") {
        const joined = runCli(fx.repo, ["wait", entry.worktree]);
        if (joined.error || joined.status !== 0) failures.push(joined.stderr);
      }
    }
    const finalizers = jsonLines<number>(join(fx.repo, "finalize-pids.jsonl"));
    for (const pid of finalizers) {
      try {
        await waitUntil(() => !isAlive(pid), `finalizer ${pid} cleanup`);
      } catch (err) {
        failures.push(err);
      }
    }
    if (
      ownedChildren.every((running) => running.closed) &&
      [...pids, ...finalizers].every((pid) => !isAlive(pid))
    ) {
      rmSync(fx.root, { recursive: true, force: true });
    }
  }
  expect(failures).toEqual([]);
});

describe("registered callback identity (e2e)", () => {
  it(
    "escalates a TERM-resistant owned server and clears its process group",
    async () => {
      const target = prepareTarget();
      const started = runDev(target.root, ["up"], { ...ENV, E2E_RESIST_TERM: "1" });
      expect(started.status, started.stderr).toBe(0);
      const pid = spawns(target.fx).at(-1)?.pid;
      if (pid === undefined) throw new Error("Missing resistant server PID");
      const stopped = runDev(target.root, ["down"], ENV);
      expect(stopped.status, stopped.stderr).toBe(0);
      await waitUntil(() => !isAlive(pid), "resistant server exit");
      expect(() => process.kill(-pid, 0)).toThrow();
      expect(devEntries(target.fx)).toEqual([]);
      expect(stops(target.fx)).toEqual(expectedStops(target.ctx));
    },
    TIMEOUT_MS,
  );

  it(
    "starts, reports, attaches and stops from a nested directory using root logs",
    async () => {
      const target = prepareTarget();
      const { fx, root, nested, ctx } = target;
      const started = runDev(root, ["up"], ENV, nested);
      expect(started.status, started.stderr).toBe(0);
      expect(started.stdout).toContain(`Workspace: ${ctx.name}`);
      const log = join(root, ".wt", "logs", "ready.log");
      expect(started.stdout).toContain(`log: ${log}`);
      expect(readFileSync(log, "utf-8")).toContain("FIXTURE_READY");
      expect(existsSync(join(nested, ".wt"))).toBe(false);
      expect(spawns(fx).map((event) => event.cwd)).toEqual([root]);
      expect(devEntries(fx)[0]).toMatchObject({ name: ctx.name, worktree: root });
      expect(callbacks(fx).filter((event) => event.event === "start")).toEqual([
        { event: "start", ...ctx, label: "docker" },
        { event: "start", ...ctx, label: "cache" },
      ]);
      expect(callbacks(fx)).toContainEqual({ event: "legacyStart", cwd: root, ports: ctx.ports });
      const status = runDev(root, ["status"], ENV, nested);
      expect(status.status, status.stderr).toBe(0);
      expect(status.stdout).toContain("status: UP");
      expect(status.stdout).toContain(`log: ${log}`);
      const noop = runDev(root, ["up"], ENV, nested);
      expect(noop.status, noop.stderr).toBe(0);
      expect(noop.stdout).toContain("already running");
      expect(spawns(fx)).toHaveLength(1);

      const attached = foreground(target);
      await waitUntil(() => attached.output.includes("FIXTURE_READY"), "root log replay");
      attached.child.kill("SIGINT");
      await exited(attached, 0);
      expect(attached.output).toContain("Detached.");
      expect(stops(fx)).toEqual([]);
      expect(isAlive(spawns(fx)[0].pid)).toBe(true);

      const stopped = runDev(root, ["down"], ENV, nested);
      expect(stopped.status, stopped.stderr).toBe(0);
      expect(stops(fx)).toEqual(expectedStops(ctx));
      expect(callbacks(fx)).toContainEqual({ event: "legacyStop", cwd: root, ports: ctx.ports });
      expect(devEntries(fx)).toEqual([]);
      await waitUntil(() => !isAlive(spawns(fx)[0].pid), "local down");
      expect(runDev(root, ["status"], ENV, nested).stdout).toContain("status: DOWN");
      expect(runDev(root, ["down"], ENV, nested).status).toBe(0);
      expect(stops(fx)).toEqual(expectedStops(ctx));
    },
    TIMEOUT_MS,
  );

  it(
    "stops a dev-only record using its recorded name after workspace registration disappears",
    () => {
      const { fx, root, nested, ctx } = prepareTarget();
      expect(runDev(root, ["up"], ENV, nested).status).toBe(0);
      const registry = readWorkspaces(fx.repo);
      delete registry.workspaces[ctx.name];
      writeWorkspaces(fx.repo, registry);
      const stopped = runDev(root, ["down"], ENV, nested);
      expect(stopped.status, stopped.stderr).toBe(0);
      expect(stops(fx)).toEqual(expectedStops({ ...ctx, ports: {} }));
      expect(devEntries(fx)).toEqual([]);
    },
    TIMEOUT_MS,
  );

  it(
    "rolls back only successful callbacks with their original complete context",
    () => {
      const { fx, root, nested, ctx } = prepareTarget();
      const failed = runDev(root, ["up"], { ...ENV, E2E_CALLBACK_START_FAIL: "cache" }, nested);
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain("e2e callback start boom");
      expect(callbacks(fx)).toEqual([
        { event: "start", ...ctx, label: "docker" },
        { event: "start", ...ctx, label: "cache" },
        { event: "stop", ...ctx, label: "docker" },
      ]);
      expect(devEntries(fx)).toEqual([]);
      expect(spawns(fx)).toEqual([]);
    },
    TIMEOUT_MS,
  );

  it.each(["SIGINT", "SIGTERM"] as const)(
    "%s after readiness stops the recorded identity",
    async (signal) => {
      const target = prepareTarget();
      const running = foreground(target);
      await waitUntil(() => running.output.includes("Dev servers started!"), "foreground ready");
      expect(devEntries(target.fx)[0].name).toBe(target.ctx.name);
      running.child.kill(signal);
      await exited(running, 0);
      expect(stops(target.fx)).toEqual(expectedStops(target.ctx));
      expect(devEntries(target.fx)).toEqual([]);
      await waitUntil(
        () => spawns(target.fx).every((event) => !isAlive(event.pid)),
        "shutdown pids",
      );
    },
    TIMEOUT_MS,
  );

  it(
    "a signal before readiness rolls back the prepared identity without registering",
    async () => {
      const target = prepareTarget();
      const barrier = newBarrier(target.fx, "ready.release");
      const running = foreground(target, { E2E_READY_BARRIER: barrier });
      await waitUntil(() => spawns(target.fx).length === 1, "spawn before readiness");
      expect(callbacks(target.fx).filter((event) => event.event === "start")).toHaveLength(2);
      expect(running.output).not.toContain("Dev servers started!");
      running.child.kill("SIGINT");
      await exited(running, 130);
      expect(stops(target.fx)).toEqual(expectedStops(target.ctx));
      expect(devEntries(target.fx)).toEqual([]);
      await waitUntil(() => !isAlive(spawns(target.fx)[0].pid), "rollback pid");
    },
    TIMEOUT_MS,
  );

  it(
    "a signal during unresolved setup invokes no callback and spawns no server",
    async () => {
      const target = prepareTarget(false);
      const barrier = newBarrier(target.fx, "setup.release");
      const running = foreground(target, { E2E_DEV_SETUP_BARRIER: barrier });
      await waitUntil(() => existsSync(`${barrier}.entered`), "unresolved setup");
      expect(Number(readFileSync(`${barrier}.entered`, "utf-8"))).toBe(running.child.pid);
      running.child.kill("SIGINT");
      await exited(running, 130);
      writeFileSync(barrier, "release\n");
      expect(callbacks(target.fx)).toEqual([]);
      expect(spawns(target.fx)).toEqual([]);
      expect(devEntries(target.fx)).toEqual([]);
    },
    TIMEOUT_MS,
  );

  it.each(["owned", "attached"])(
    "external down stops callbacks once and exits the %s foreground",
    async (mode) => {
      const target = prepareTarget();
      if (mode === "attached") expect(runDev(target.root, ["up"], ENV).status).toBe(0);
      const running = foreground(target);
      await waitUntil(
        () => running.output.includes(mode === "owned" ? "Dev servers started!" : "Attaching"),
        "foreground ownership",
      );
      const stopped = runDev(target.root, ["down"], ENV, target.nested);
      expect(stopped.status, stopped.stderr).toBe(0);
      await exited(running, 0);
      expect(running.output).toContain("stopped externally");
      expect(stops(target.fx)).toEqual(expectedStops(target.ctx));
      expect(devEntries(target.fx)).toEqual([]);
    },
    TIMEOUT_MS,
  );

  it(
    "down --all reverse-stops same-basename victims using their identities, not the caller's",
    () => {
      const target = prepareTarget();
      const { fx, root, ctx } = target;
      const other = addWorktree(fx, "three/review", "three");
      setup(fx, other);
      expect(runDev(other, ["up"], ENV).status).toBe(0);
      expect(runDev(root, ["up"], ENV).status).toBe(0);
      const registeredOther = Object.entries(readWorkspaces(fx.repo).workspaces).find(
        ([, entry]) => entry.worktree === other,
      );
      if (!registeredOther) throw new Error("Missing other victim registration");
      const [name, entry] = registeredOther;
      expect(name).toMatch(/^review-[a-f0-9]{8}$/);
      expect(name).not.toBe(ctx.name);
      const otherCtx = { name, cwd: other, ports: entry.ports ?? {} };
      expect(runDev(fx.repo, ["setup"]).status).toBe(0);
      expect(readWorkspaces(fx.repo).workspaces.fixrepo.main).toBe(true);
      const result = runDev(fx.repo, ["down", "--all"], ENV);
      expect(result.status, result.stderr).toBe(0);
      expect(stops(fx)).toEqual([...expectedStops(otherCtx), ...expectedStops(ctx)]);
      expect(devEntries(fx)).toEqual([]);
    },
    TIMEOUT_MS,
  );

  it(
    "eviction dispatches the caller's callbacks with the suffixed victim's identity",
    () => {
      const { fx, root, ctx } = prepareTarget();
      expect(runDev(root, ["up"], ENV).status).toBe(0);
      const result = runDev(fx.repo, ["up", "--evict"], { ...ENV, E2E_DEV_CAP: "1" });
      expect(result.status, result.stderr).toBe(0);
      expect(stops(fx)).toEqual(expectedStops(ctx));
      expect(devEntries(fx).map((entry) => entry.name)).toEqual(["fixrepo"]);
      expect(runDev(fx.repo, ["down"], ENV).status).toBe(0);
    },
    TIMEOUT_MS,
  );
});

function prepareTarget(devSetup = true): Target {
  const fx = createFixtureRepo();
  fixtures.push(fx);
  const first = addWorktree(fx, "one/review", "one");
  const root = addWorktree(fx, "two/review", "two");
  for (const worktree of [first, root]) setup(fx, worktree);
  if (devSetup) expect(runDev(root, ["setup"]).status).toBe(0);
  const [name, entry] =
    Object.entries(readWorkspaces(fx.repo).workspaces).find(
      ([, value]) => value.worktree === root,
    ) ?? [];
  if (name === undefined || entry === undefined) throw new Error("Missing target registration");
  expect(name).toMatch(/^review-[a-f0-9]{8}$/);
  const nested = join(root, "nested", "inside");
  mkdirSync(nested, { recursive: true });
  return { fx, root, nested, ctx: { name, cwd: root, ports: entry.ports ?? {} } };
}

function setup(fx: FixtureRepo, worktree: string): void {
  const result = runCli(fx.repo, ["setup"], undefined, worktree);
  expect(result.status, result.stderr).toBe(0);
}

function addWorktree(fx: FixtureRepo, path: string, branch: string): string {
  const target = join(fx.root, path);
  mkdirSync(dirname(target), { recursive: true });
  execFileSync("git", ["worktree", "add", "-b", branch, target], { cwd: fx.repo, stdio: "pipe" });
  return target;
}

function foreground(target: Target, env: Record<string, string> = {}): RunningChild {
  const child = spawn(cliExecutable, [join(target.root, "scripts", "dev-server.mjs")], {
    cwd: target.nested,
    env: { ...process.env, ...ENV, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const running: RunningChild = { child, output: "", closed: false };
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (data: Buffer) => {
      running.output = (running.output + data.toString()).slice(-16_000);
    });
  }
  child.on("close", () => {
    running.closed = true;
  });
  children.push(running);
  return running;
}

async function exited(running: RunningChild, code: number): Promise<void> {
  await waitUntil(() => running.closed, `foreground exit: ${running.output}`);
  expect(running.child.exitCode, running.output).toBe(code);
  expect(running.child.signalCode).toBeNull();
}

function newBarrier(fx: FixtureRepo, name: string): string {
  const path = join(fx.root, name);
  barriers.push(path);
  return path;
}

function callbacks(fx: FixtureRepo): CallbackEvent[] {
  return jsonLines(join(fx.repo, "callback-runs.jsonl"));
}

function stops(fx: FixtureRepo): CallbackEvent[] {
  return callbacks(fx).filter((event) => event.event === "stop");
}

function expectedStops(ctx: ServerContext): CallbackEvent[] {
  return ["cache", "docker"].map((label) => ({ event: "stop", ...ctx, label }));
}

function spawns(fx: FixtureRepo): SpawnEvent[] {
  return jsonLines(join(fx.repo, "spawn-runs.jsonl"));
}

function jsonLines<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .trim()
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

function devEntries(fx: FixtureRepo): DevServerEntry[] {
  const file = join(fx.repo, ".wt", "workspace-registry", "dev-servers.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf-8")).servers : [];
}

async function waitUntil(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
