import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveWorkspaceStorage } from "../../src/storage.js";
import type { WorkspaceManifest } from "../../src/workspace-config-types.js";
import type { DevServerEntry } from "../../src/dev-servers-registry.js";
import type { ServerContext } from "../../src/server-descriptor.js";
import {
  cliExecutable,
  alignfirstBin,
  createFixtureRepo,
  installResourceRecipe,
  resourceEvents,
  type FixtureRepo,
  fixtureRegistryDir,
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

  it.each([false, true])(
    "starts, reports, attaches and stops from nested cwd (companion runtime=%s)",
    async (companionRuntime) => {
      const target = prepareTarget(true, companionRuntime);
      const { fx, root, nested, ctx } = target;
      const file = join(root, "alignfirst.json");
      const manifest = JSON.parse(readFileSync(file, "utf8"));
      manifest.devServer.maxConcurrentDevServers = { env: "E2E_DEV_LIMIT", default: 0 };
      writeFileSync(file, JSON.stringify(manifest));
      const started = runDev(root, ["up"], ENV, nested);
      expect(started.status, started.stderr).toBe(0);
      expect(started.stdout).toContain(`Workspace: ${ctx.name}`);
      const runtime = resolveWorkspaceStorage(
        {
          in: companionRuntime ? "companion" : "project",
          mainWorktree: fx.repo,
          companionDir: join(fx.root, "companion"),
        },
        root,
      ).runtimeDir;
      const log = join(runtime, "logs", "ready.log");
      expect(started.stdout).toContain(`log: ${log}`);
      expect(readFileSync(log, "utf-8")).toContain("FIXTURE_READY");
      expect(existsSync(join(nested, ".local-wt"))).toBe(false);
      expect(spawns(fx).map((event) => event.cwd)).toEqual([root]);
      expect(devEntries(fx)[0]).toMatchObject({ name: ctx.name, worktree: root });
      expect(callbacks(fx).filter((event) => event.event === "start")).toEqual([
        { event: "start", ...ctx, label: "docker" },
        { event: "start", ...ctx, label: "cache" },
      ]);
      expect(callbacks(fx)).toContainEqual({
        event: "legacyStart",
        name: ctx.name,
        cwd: root,
        ports: ctx.ports,
      });
      const status = runDev(root, ["status"], ENV, nested);
      expect(status.status, status.stderr).toBe(0);
      expect(status.stdout).toContain("status: UP");
      expect(status.stdout).toContain(`log: ${log}`);
      const noop = runDev(root, ["up"], { ...ENV, E2E_DEV_LIMIT: "invalid" }, nested);
      expect(noop.status, noop.stderr).toBe(0);
      expect(noop.stdout).toContain("already running");
      expect(spawns(fx)).toHaveLength(1);

      const attached = foreground(target, { E2E_DEV_LIMIT: "invalid" });
      await waitUntil(() => attached.output.includes("FIXTURE_READY"), "root log replay");
      attached.child.kill("SIGINT");
      await exited(attached, 0);
      expect(attached.output).toContain("Detached.");
      expect(stops(fx)).toEqual([]);
      expect(isAlive(spawns(fx)[0].pid)).toBe(true);

      const stopped = runDev(root, ["down"], ENV, nested);
      expect(stopped.status, stopped.stderr).toBe(0);
      expect(stops(fx)).toEqual(expectedStops(ctx));
      expect(callbacks(fx)).toContainEqual({
        event: "legacyStop",
        name: ctx.name,
        cwd: root,
        ports: ctx.ports,
      });
      expect(devEntries(fx)).toEqual([]);
      await waitUntil(() => !isAlive(spawns(fx)[0].pid), "local down");
      expect(runDev(root, ["status"], ENV, nested).stdout).toContain("status: DOWN");
      expect(runDev(root, ["down"], ENV, nested).status).toBe(0);
      expect(stops(fx)).toEqual(expectedStops(ctx));
    },
    TIMEOUT_MS,
  );

  it(
    "rejects startup overrides before claims, setup, file writes or stopping a live instance",
    async () => {
      const { fx, root } = prepareTarget(false);
      const file = join(root, "alignfirst.json");
      const manifest = JSON.parse(readFileSync(file, "utf8"));
      manifest.devServer.maxConcurrentDevServers = { env: "E2E_DEV_LIMIT", default: 1 };
      writeFileSync(file, JSON.stringify(manifest));
      const invalid = { ...ENV, E2E_DEV_LIMIT: "PRIVATE" };
      const paths = [
        ...["workspaces.json", "dev-servers.json", "dev-startups.json"].map((name) =>
          join(fx.repo, ".local-wt/workspace-registry", name),
        ),
        join(root, "setup-runs.log"),
        join(root, "ports.env"),
        join(root, "ports.txt"),
      ];
      const bytes = () =>
        paths.map((path) => (existsSync(path) ? readFileSync(path, "utf8") : undefined));
      const before = bytes();
      const failed = runDev(root, ["up"], invalid);
      expect(failed.status, failed.stderr).toBe(1);
      expect(failed.stderr).toContain("maxConcurrentDevServers: E2E_DEV_LIMIT");
      expect(failed.stderr).not.toContain("PRIVATE");
      expect(bytes()).toEqual(before);
      // Zero overrides a finite default and permits more than one live environment.
      expect(runDev(fx.repo, ["up"], ENV).status).toBe(0);
      expect(runDev(root, ["up"], { ...ENV, E2E_DEV_LIMIT: "0" }).status).toBe(0);
      const pid = spawns(fx).find((event) => event.cwd === root)?.pid;
      if (pid === undefined) throw new Error("Missing target PID");
      writeFileSync(join(root, "ports.env"), "hand edited\n");
      const runningBytes = bytes();
      for (const args of [["restart"], ["up", "--restart"], ["--restart"]]) {
        const rejected = runDev(root, args, invalid);
        expect(rejected.status, rejected.stderr).toBe(1);
        expect(rejected.stderr).toContain("maxConcurrentDevServers: E2E_DEV_LIMIT");
        expect(isAlive(pid)).toBe(true);
        expect(bytes()).toEqual(runningBytes);
      }
      expect(runDev(root, ["status"], invalid).status).toBe(0);
      expect(runDev(root, ["list"], invalid).status).toBe(0);
      const report = JSON.parse(
        execFileSync(cliExecutable, [alignfirstBin, "config", "--json"], {
          cwd: root,
          encoding: "utf8",
          env: { ...process.env, HOME: join(fx.root, "home"), ...invalid },
        }),
      );
      expect(report.config.devServer.maxConcurrentDevServers).toEqual({
        env: "E2E_DEV_LIMIT",
        default: 1,
      });
      expect(runDev(root, ["down"], invalid).status).toBe(0);
      await waitUntil(() => !isAlive(pid), "down with invalid startup override");
      expect(runDev(root, ["setup", "--force"], invalid).status).toBe(0);
      expect(runCli(root, ["setup", "--full", "--force"], invalid).status).toBe(0);
      expect(runDev(fx.repo, ["down"], ENV).status).toBe(0);
    },
    TIMEOUT_MS,
  );

  it.each([false, true])(
    "stops using current callbacks without interpolating startup commands, allocation missing=%s",
    async (missingAllocation) => {
      const { fx, root, nested, ctx } = prepareTarget();
      expect(runDev(root, ["up"], ENV, nested).status).toBe(0);
      if (missingAllocation) {
        const registry = readWorkspaces(fx.repo);
        delete registry.workspaces[ctx.name];
        writeWorkspaces(fx.repo, registry);
      }
      const file = join(root, "alignfirst.json");
      const manifest: WorkspaceManifest = JSON.parse(readFileSync(file, "utf8"));
      const dev = manifest.devServer;
      if (!dev?.ports) throw new Error("Missing fixture dev ports");
      dev.ports.declare.push("newPort");
      for (const server of dev.servers) {
        if (server.kind !== "spawn") continue;
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Manifest interpolation syntax.
        server.exec = { run: [cliExecutable, "${{ ports.newPort }}"] };
        server.port = "newPort";
      }
      writeFileSync(file, JSON.stringify(manifest));
      const stopped = runDev(root, ["down"], ENV, nested);
      expect(stopped.status, stopped.stderr).toBe(0);
      expect(stops(fx)).toEqual(
        expectedStops({ ...ctx, ports: missingAllocation ? {} : ctx.ports }),
      );
      expect(devEntries(fx)).toEqual([]);
      await waitUntil(() => spawns(fx).every((event) => !isAlive(event.pid)), "recorded PID stop");
    },
    TIMEOUT_MS,
  );

  it.each(["setup", "readiness"] as const)(
    "a competing restart cannot mutate or stop the startup owner during %s",
    async (phase) => {
      const target = prepareTarget(phase !== "setup");
      const barrier = newBarrier(target.fx, `${phase}.release`);
      const running = foreground(
        target,
        phase === "setup" ? { E2E_DEV_SETUP_BARRIER: barrier } : { E2E_READY_BARRIER: barrier },
        ["up"],
      );
      await waitUntil(
        () =>
          phase === "setup" ? existsSync(`${barrier}.entered`) : spawns(target.fx).length === 1,
        `winner blocked during ${phase}`,
      );
      const before = callbacks(target.fx);
      const recorded = devEntries(target.fx);
      const lost = runDev(target.root, ["up", "--restart"], ENV);
      expect(lost.status, lost.stderr).toBe(1);
      expect(lost.stderr).toContain("startup already in progress");
      expect(callbacks(target.fx)).toEqual(before);
      expect(devEntries(target.fx)).toEqual(recorded);
      expect(stops(target.fx)).toEqual([]);
      expect(spawns(target.fx).every((event) => isAlive(event.pid))).toBe(true);
      writeFileSync(barrier, "release\n");
      await exited(running, 0);
      expect(spawns(target.fx)).toHaveLength(1);
      expect(callbacks(target.fx).filter((event) => event.event === "start")).toHaveLength(2);
      expect(devEntries(target.fx)).toMatchObject([
        { name: target.ctx.name, worktree: target.root },
      ]);
      expect(runDev(target.root, ["down"], ENV).status).toBe(0);
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

  it.each([false, true])(
    "a signal before readiness awaits rollback and retains stop failure=%s",
    async (failStop) => {
      const target = prepareTarget();
      const barrier = newBarrier(target.fx, "ready.release");
      const running = foreground(target, {
        E2E_READY_BARRIER: barrier,
        ...(failStop ? { E2E_CALLBACK_STOP_FAIL: "1" } : {}),
      });
      await waitUntil(() => spawns(target.fx).length === 1, "spawn before readiness");
      expect(callbacks(target.fx).filter((event) => event.event === "start")).toHaveLength(2);
      expect(running.output).not.toContain("Dev servers started!");
      running.child.kill("SIGINT");
      await exited(running, 130);
      expect(stops(target.fx)).toEqual(expectedStops(target.ctx));
      await waitUntil(() => !isAlive(spawns(target.fx)[0].pid), "rollback pid");
      if (failStop) {
        expect(devEntries(target.fx)).toMatchObject([
          { name: target.ctx.name, cleanupPending: true },
        ]);
        expect(runDev(target.root, ["down"], ENV).status).toBe(0);
      }
      expect(devEntries(target.fx)).toEqual([]);
    },
    TIMEOUT_MS,
  );

  it(
    "a signal during unresolved setup invokes no callback and spawns no server",
    async () => {
      const target = prepareTarget(false);
      const barrier = newBarrier(target.fx, "setup.release");
      const grandchildFile = join(target.fx.root, "setup-grandchild.pid");
      const running = foreground(target, {
        E2E_DEV_SETUP_BARRIER: barrier,
        E2E_SETUP_GRANDCHILD_FILE: grandchildFile,
      });
      await waitUntil(() => existsSync(`${barrier}.entered`), "unresolved setup");
      const setupPid = Number(readFileSync(`${barrier}.entered`, "utf-8"));
      expect(setupPid).not.toBe(running.child.pid);
      running.child.kill("SIGINT");
      await exited(running, 130);
      await waitUntil(() => !isAlive(setupPid), "cancelled setup command");
      const grandchild = Number(readFileSync(grandchildFile, "utf8"));
      await waitUntil(() => !isAlive(grandchild), "cancelled setup grandchild");
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

  it.each(["manifest", "defaults", "companionRuntime"])(
    "down --all from %s executes victim-only scripts with their recorded identities",
    (caller) => {
      const target = prepareTarget(true, caller === "companionRuntime");
      const { fx, root, ctx } = target;
      const other = addWorktree(fx, "three/review", "three");
      setup(fx, other);
      installResourceRecipe(other, "victim-only");
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
      if (caller !== "defaults") {
        installResourceRecipe(fx.repo, "caller-version", { service: false });
        expect(runDev(fx.repo, ["setup"]).status).toBe(0);
        expect(readWorkspaces(fx.repo).workspaces.fixrepo.main).toBe(true);
      } else rmSync(join(fx.repo, "alignfirst.json"));
      renameSync(join(other, "alignfirst.json"), join(other, "alignfirst.jsonc"));
      const result = runDev(fx.repo, ["down", "--all"], ENV);
      expect(result.status, result.stderr).toBe(0);
      expect(stops(fx)).toEqual([...expectedStops(otherCtx), ...expectedStops(ctx)]);
      expect(resourceEvents(fx.repo).filter((event) => event.action === "stop")).toEqual([
        expect.objectContaining({
          version: "victim-only",
          recipeVersion: "victim-only",
          cwd: other,
          ctx: expect.objectContaining({
            name,
            currentWorktree: other,
            ports: otherCtx.ports,
            phase: "stop",
          }),
        }),
      ]);
      expect(existsSync(join(fx.root, "resources", name))).toBe(false);
      expect(devEntries(fx)).toEqual([]);
    },
    TIMEOUT_MS,
  );

  it.each([
    { fail: false, companionRuntime: false },
    { fail: true, companionRuntime: true },
  ])(
    "eviction uses the victim recipe and preserves failed stop ownership ($fail, companion=$companionRuntime)",
    ({ fail, companionRuntime }) => {
      const { fx, root, ctx } = prepareTarget(true, companionRuntime);
      installResourceRecipe(root, "victim-version");
      installResourceRecipe(fx.repo, "caller-version", { service: false });
      expect(runDev(root, ["up"], ENV).status).toBe(0);
      const path = join(fx.repo, "alignfirst.json");
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      manifest.devServer.maxConcurrentDevServers = 1;
      writeFileSync(path, JSON.stringify(manifest));
      const result = runDev(fx.repo, ["up", "--evict"], {
        ...ENV,
        ...(fail ? { E2E_RESOURCE_FAIL: "stop" } : {}),
      });
      expect(result.status, result.stderr).toBe(fail ? 1 : 0);
      expect(stops(fx)).toEqual(expectedStops(ctx));
      expect(resourceEvents(fx.repo).find((event) => event.action === "stop")).toMatchObject({
        version: "victim-version",
        recipeVersion: "victim-version",
        cwd: root,
        ctx: { name: ctx.name, ports: ctx.ports },
      });
      if (fail) {
        expect(devEntries(fx)).toMatchObject([{ name: ctx.name, cleanupPending: true }]);
        expect(spawns(fx)).toHaveLength(1);
        expect(runDev(root, ["down"], ENV).status).toBe(0);
      } else {
        expect(devEntries(fx).map((entry) => entry.name)).toEqual(["fixrepo"]);
        expect(runDev(fx.repo, ["down"], ENV).status).toBe(0);
      }
    },
    TIMEOUT_MS,
  );
  it(
    "retains stop work across PID exit, concurrent listing/start and a failed command",
    async () => {
      const target = prepareTarget();
      const { fx, root, ctx } = target;
      installResourceRecipe(root, "barrier-victim");
      const callerManifestPath = join(fx.repo, "alignfirst.json");
      const callerManifest = JSON.parse(readFileSync(callerManifestPath, "utf8"));
      callerManifest.devServer.maxConcurrentDevServers = 1;
      writeFileSync(callerManifestPath, JSON.stringify(callerManifest));
      expect(runDev(root, ["up"], ENV).status).toBe(0);
      const pid = spawns(fx)[0].pid;
      const barrier = newBarrier(fx, "stop.release");
      const stopping = foreground(
        target,
        { E2E_RESOURCE_STOP_BARRIER: barrier, E2E_RESOURCE_FAIL: "stop" },
        ["down"],
      );
      await waitUntil(() => existsSync(`${barrier}.entered`), "stop barrier after PID exit");
      expect(isAlive(pid)).toBe(false);
      expect(runDev(fx.repo, ["list"]).stdout).toContain("cleanupPending=true");
      expect(runDev(root, ["up"], ENV).stderr).toContain("Cleanup is pending");
      expect(spawns(fx)).toHaveLength(1);
      expect(runDev(fx.repo, ["up"], ENV).status).toBe(0);
      const sibling = devEntries(fx).find((entry) => entry.worktree === fx.repo);
      writeFileSync(barrier, "release\n");
      await exited(stopping, 1);
      expect(devEntries(fx).find((entry) => entry.worktree === root)).toMatchObject({
        name: ctx.name,
        cleanupPending: true,
      });
      expect(runDev(root, ["down"], ENV).status).toBe(0);
      expect(devEntries(fx)).toEqual([sibling]);
      expect(existsSync(join(fx.root, "resources", ctx.name))).toBe(false);
      expect(runDev(fx.repo, ["down"], ENV).status).toBe(0);
    },
    TIMEOUT_MS,
  );

  it.each(["missing", "malformed"])(
    "down-all retains a %s victim recipe failure while cleaning other targets",
    (kind) => {
      const { fx, root, ctx } = prepareTarget();
      expect(runDev(root, ["up"], ENV).status).toBe(0);
      expect(runDev(fx.repo, ["up"], ENV).status).toBe(0);
      const manifest = join(root, "alignfirst.json");
      const saved = readFileSync(manifest, "utf8");
      if (kind === "missing") rmSync(manifest);
      else writeFileSync(manifest, "{bad json}");
      const failed = runDev(fx.repo, ["down", "--all"], ENV);
      expect(failed.status).toBe(1);
      expect(devEntries(fx)).toMatchObject([{ name: ctx.name, cleanupPending: true }]);
      expect(isAlive(spawns(fx)[0].pid)).toBe(true);
      expect(stops(fx).map((event) => event.name)).toEqual(["fixrepo", "fixrepo"]);
      writeFileSync(manifest, saved);
      expect(runDev(fx.repo, ["down", "--all"], ENV).status).toBe(0);
      expect(devEntries(fx)).toEqual([]);
    },
    TIMEOUT_MS,
  );

  it(
    "retains failed pre-registration rollback for an explicit dead-PID retry",
    () => {
      const { fx, root, ctx } = prepareTarget();
      const failed = runDev(root, ["up"], {
        ...ENV,
        E2E_CALLBACK_START_FAIL: "cache",
        E2E_CALLBACK_STOP_FAIL: "1",
      });
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain("e2e callback start boom");
      expect(spawns(fx)).toEqual([]);
      expect(devEntries(fx)).toMatchObject([
        { name: ctx.name, worktree: root, pids: {}, cleanupPending: true },
      ]);
      expect(runDev(root, ["list"]).stdout).toContain(ctx.name);
      expect(runDev(root, ["up"], ENV).stderr).toContain("Cleanup is pending");
      expect(runDev(root, ["down"], ENV).status).toBe(0);
      expect(devEntries(fx)).toEqual([]);
      expect(stops(fx).map((event) => event.label)).toEqual(["docker", "cache", "docker"]);
    },
    TIMEOUT_MS,
  );
});

function prepareTarget(devSetup = true, companionRuntime = false): Target {
  const fx = createFixtureRepo({ companionRuntime });
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

function foreground(
  target: Target,
  env: Record<string, string> = {},
  args: string[] = [],
): RunningChild {
  const child = spawn(cliExecutable, [alignfirstBin, "dev", ...args], {
    cwd: target.nested,
    env: { ...process.env, HOME: join(target.fx.root, "home"), ...ENV, ...env },
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
  const file = join(fixtureRegistryDir(fx.repo), "dev-servers.json");
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
