import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { WorkspaceManifest } from "../../src/workspace-config-types.js";
import {
  alignfirstBin,
  cliExecutable,
  createFixtureRepo,
  type FixtureRepo,
  type FixtureOptions,
  readWorkspaces,
  writeWorkspaces,
  runCli,
  runDev,
} from "./fixture.js";

const TIMEOUT_MS = 60_000;
const fixtures: FixtureRepo[] = [];
const children: RunningChild[] = [];
const ownedPids = new Set<number>();

interface RunningChild {
  child: ChildProcess;
  closed: boolean;
  code: number | null;
  output: string;
}

afterEach(async () => {
  for (const fx of fixtures) writeFileSync(join(fx.root, "release"), "release");
  for (const running of children.splice(0)) {
    if (!running.closed) running.child.kill("SIGTERM");
    try {
      await waitUntil(() => running.closed, "CLI exit");
    } finally {
      if (!running.closed) running.child.kill("SIGKILL");
    }
  }
  for (const pid of ownedPids) {
    if (isAlive(pid)) process.kill(pid, "SIGKILL");
    await waitUntil(() => !isAlive(pid), `owned process ${pid} exit`);
  }
  ownedPids.clear();
  for (const fx of fixtures.splice(0)) {
    const entries = readWorkspaces(fx.repo).workspaces;
    if (
      Object.values(entries).some(
        (entry) => entry.status === "pending" && entry.cleanupPending !== true,
      )
    ) {
      const result = runCli(fx.repo, ["wait"]);
      expect(result.status, result.stderr).toBe(0);
    }
    rmSync(fx.root, { recursive: true, force: true });
  }
});

describe("installed workspace CLI cancellation", () => {
  it.each([false, true])(
    "excludes a second cleaner while permitting unrelated cleanup, companion=%s",
    async (companionRuntime) => {
      const fx = fixture({ companionRuntime });
      const linked = join(fx.root, "linked");
      const sibling = join(fx.root, "sibling");
      for (const [branch, path] of [
        ["linked", linked],
        ["sibling", sibling],
      ]) {
        execFileSync("git", ["worktree", "add", "-b", branch, path], { cwd: fx.repo });
        expect(runCli(fx.repo, ["setup", "--path", path]).status).toBe(0);
      }
      installBarrier(fx, linked, "purge");
      const resource = join(linked, "replacement-resource");
      writeFileSync(resource, "original");
      const purgeScript = join(linked, "scripts/interrupt.mjs");
      writeFileSync(
        purgeScript,
        `${readFileSync(purgeScript, "utf8")}\nrmSync(${JSON.stringify(resource)}, { force: true });\n`,
      );
      writeFileSync(join(fx.root, "home/release"), "release");
      const running = startCli(fx, fx.repo, ["workspace", "teardown", linked]);
      const pids = await waitForOwnedCommand(fx);
      const competing = runCli(fx.repo, ["teardown", linked], {
        INTERRUPT_DIR: join(fx.root, "home"),
      });
      expect(competing.status, competing.stderr).toBe(1);
      expect(competing.stderr).toMatch(/cleanup.*in progress/i);
      expect(existsSync(join(fx.root, "later"))).toBe(false);
      expect(readFileSync(resource, "utf8")).toBe("original");
      expect(runCli(fx.repo, ["setup", "--path", linked, "--force"]).status).toBe(1);
      const unrelated = runCli(fx.repo, ["teardown", sibling]);
      expect(unrelated.status, unrelated.stderr).toBe(0);
      expect(running.closed).toBe(false);
      writeFileSync(join(fx.root, "release"), "release");
      await waitUntil(() => running.closed, "first cleanup settlement");
      expect(running.code, running.output).toBe(0);
      await waitUntil(() => pids.every((pid) => !isAlive(pid)), "purge command exit");
      const adopted = runCli(fx.repo, ["setup", "--path", linked]);
      expect(adopted.status, adopted.stderr).toBe(0);
      expect(existsSync(resource)).toBe(false);
      writeFileSync(resource, "replacement");
      expect(Object.values(readWorkspaces(fx.repo).workspaces)).toMatchObject([
        { worktree: linked, status: "ready" },
      ]);
      expect(readFileSync(resource, "utf8")).toBe("replacement");
    },
    TIMEOUT_MS,
  );

  it.each([false, true])(
    "requires explicit recovery after a killed cleaner leaves purge alive, companion=%s",
    async (companionRuntime) => {
      const fx = fixture({ companionRuntime });
      const linked = join(fx.root, "linked");
      execFileSync("git", ["worktree", "add", "-b", "linked", linked], { cwd: fx.repo });
      expect(runCli(fx.repo, ["setup", "--path", linked]).status).toBe(0);
      expect(runDev(linked, ["setup"]).status).toBe(0);
      installBarrier(fx, linked, "purge");
      const resource = join(linked, "replacement-resource");
      writeFileSync(resource, "original");
      const script = join(linked, "scripts/interrupt.mjs");
      writeFileSync(
        script,
        `${readFileSync(script, "utf8")}\nrmSync(${JSON.stringify(resource)}, { force: true });\n`,
      );
      writeFileSync(join(fx.root, "home/release"), "release");
      const running = startCli(fx, fx.repo, ["workspace", "teardown", linked]);
      const pids = await waitForOwnedCommand(fx);
      const captured = readWorkspaces(fx.repo);
      const name = Object.keys(captured.workspaces)[0];
      expect(captured.workspaces[name].cleanupOwner?.pid).toBe(running.child.pid);
      expect(captured.workspaces[name].ports).toBeDefined();
      running.child.kill("SIGKILL");
      await waitUntil(
        () => running.child.pid !== undefined && !isAlive(running.child.pid),
        "cleaner death",
      );
      expect(pids.every(isAlive)).toBe(true);
      for (const args of [
        ["teardown", linked],
        ["remove", linked, "--force"],
      ]) {
        const retry = runCli(fx.repo, args, { INTERRUPT_DIR: join(fx.root, "home") });
        expect(retry.status, retry.stderr).toBe(1);
        expect(retry.stderr).toMatch(/abandoned cleanup.*explicit recovery/i);
        expect(readWorkspaces(fx.repo)).toEqual(captured);
        expect(readFileSync(resource, "utf8")).toBe("original");
      }
      expect(runCli(fx.repo, ["setup", "--path", linked, "--force"]).status).toBe(1);
      expect(runDev(linked, ["setup"]).status).toBe(1);
      expect(runDev(linked, ["up"]).status).toBe(1);
      expect(readWorkspaces(fx.repo)).toEqual(captured);
      expect(pids.every(isAlive)).toBe(true);
      process.kill(-pids[0], "SIGKILL");
      await waitUntil(() => pids.every((pid) => !isAlive(pid)), "owned purge group termination");
      await waitUntil(() => running.closed, "killed CLI output closure");
      // All fixture lifecycle callers have returned and the known purge group is stopped.
      const recovered = readWorkspaces(fx.repo);
      delete recovered.workspaces[name].cleanupOwner;
      writeWorkspaces(fx.repo, recovered);
      expect(readWorkspaces(fx.repo)).toEqual(recovered);
      expect(recovered.workspaces[name]).toMatchObject({
        cleanupPending: true,
        recipe: captured.workspaces[name].recipe,
        ports: captured.workspaces[name].ports,
      });
      expect(recovered.runtimeOwners).toEqual(captured.runtimeOwners);
      const retry = runCli(fx.repo, ["teardown", linked], { INTERRUPT_DIR: join(fx.root, "home") });
      expect(retry.status, retry.stderr).toBe(0);
      expect(existsSync(resource)).toBe(false);
      expect(runCli(fx.repo, ["setup", "--path", linked]).status).toBe(0);
      writeFileSync(resource, "replacement");
      expect(readFileSync(resource, "utf8")).toBe("replacement");
      if (companionRuntime)
        expect(Object.values(readWorkspaces(fx.repo).runtimeOwners ?? {})[0].generation).not.toBe(
          Object.values(captured.runtimeOwners ?? {})[0].generation,
        );
    },
    TIMEOUT_MS,
  );

  it(
    "rejects a stale cleaner at local settlement without releasing its replacement claim",
    async () => {
      const fx = fixture();
      expect(runCli(fx.repo, ["setup"]).status).toBe(0);
      installBarrier(fx, fx.repo, "purge");
      const running = startCli(fx, fx.repo, ["workspace", "teardown"]);
      await waitForOwnedCommand(fx);
      const file = join(fx.repo, ".local-wt/workspace-registry/workspaces.json");
      const registry = JSON.parse(readFileSync(file, "utf8"));
      const name = Object.keys(registry.workspaces)[0];
      const entry = registry.workspaces[name];
      expect(entry.cleanupOwner).toMatchObject({ pid: running.child.pid });
      entry.cleanupOwner.token = "replacement-cleaner";
      writeFileSync(file, JSON.stringify(registry));
      writeFileSync(join(fx.root, "release"), "release");
      await waitUntil(() => running.closed, "stale cleaner exit");
      expect(running.code, running.output).toBe(1);
      expect(running.output).toMatch(/cleanup ownership lost/i);
      expect(readWorkspaces(fx.repo).workspaces[name]).toEqual(entry);
      const retry = runCli(fx.repo, ["teardown"], { INTERRUPT_DIR: fx.root });
      expect(retry.status, retry.stderr).toBe(1);
      expect(retry.stderr).toMatch(/abandoned cleanup.*explicit recovery/i);
      expect(readWorkspaces(fx.repo).workspaces[name]).toEqual(entry);
    },
    TIMEOUT_MS,
  );

  it(
    "awaits interrupted preparation and its descendants, skips later steps and permits plain retry",
    async () => {
      const fx = fixture();
      installBarrier(fx, fx.repo, "preSetup");
      const running = startCli(fx, fx.repo, ["workspace", "setup", "--json"]);
      const pids = await waitForOwnedCommand(fx);
      running.child.kill("SIGINT");
      await assertInterrupted(running, pids);
      expect(existsSync(join(fx.root, "later"))).toBe(false);
      expect(Object.values(readWorkspaces(fx.repo).workspaces)[0].status).toBe("failed");
      writeFileSync(join(fx.root, "release"), "release");
      const retry = runCli(fx.repo, ["setup"], { INTERRUPT_DIR: fx.root });
      expect(retry.status, retry.stderr).toBe(0);
      expect(Object.values(readWorkspaces(fx.repo).workspaces)[0].status).toBe("ready");
    },
    TIMEOUT_MS,
  );

  it.each([
    { command: "teardown", companionRuntime: false },
    { command: "teardown", companionRuntime: true },
    { command: "removeHere", companionRuntime: false },
    { command: "abandonedPreparation", companionRuntime: false },
  ])(
    "retains interrupted target-owned purge through $command, companion=$companionRuntime, including internal re-exec cleanup",
    async ({ command, companionRuntime }) => {
      const fx = fixture({ companionRuntime });
      const linked = join(fx.root, "linked");
      execFileSync("git", ["worktree", "add", "-b", "linked", linked], { cwd: fx.repo });
      expect(runCli(fx.repo, ["setup", "--path", linked]).status).toBe(0);
      if (command === "abandonedPreparation") {
        const file = join(fx.repo, ".local-wt/workspace-registry/workspaces.json");
        const registry = JSON.parse(readFileSync(file, "utf8"));
        const entry = registry.workspaces[Object.keys(registry.workspaces)[0]];
        const deadPid = Number(
          execFileSync(cliExecutable, ["-p", "process.pid"], { encoding: "utf8" }),
        );
        Object.assign(entry, {
          status: "pending",
          preparationOwner: { pid: deadPid, token: "abandoned-preparation" },
        });
        writeFileSync(file, JSON.stringify(registry));
      }
      installBarrier(fx, linked, "purge");
      const cwd = command === "removeHere" ? linked : fx.repo;
      const args =
        command === "removeHere"
          ? ["workspace", "remove", "--force", "--json"]
          : ["workspace", "teardown", linked, "--json"];
      const running = startCli(fx, cwd, args);
      const pids = await waitForOwnedCommand(fx);
      const active = Object.values(readWorkspaces(fx.repo).workspaces).find(
        (entry) => entry.worktree === linked,
      );
      expect(active?.cleanupOwner?.token).toEqual(expect.any(String));
      expect(active?.cleanupOwner && isAlive(active.cleanupOwner.pid)).toBe(true);
      running.child.kill("SIGTERM");
      await assertInterrupted(running, pids);
      expect(existsSync(join(fx.root, "later"))).toBe(false);
      expect(existsSync(linked)).toBe(true);
      const retained = Object.values(readWorkspaces(fx.repo).workspaces).find(
        (entry) => entry.worktree === linked,
      );
      expect(retained?.cleanupPending).toBe(true);
      expect(retained?.cleanupOwner).toBeUndefined();
      expect(runCli(fx.repo, ["setup", "--path", linked, "--force"]).status).toBe(1);
      writeFileSync(join(fx.root, "release"), "release");
      const retry = runCli(fx.repo, ["teardown", linked], { INTERRUPT_DIR: fx.root });
      expect(retry.status, retry.stderr).toBe(0);
      expect(Object.values(readWorkspaces(fx.repo).workspaces)).toEqual([]);
    },
    TIMEOUT_MS,
  );

  it(
    "waits for a target stop CLI to cancel its detached command before retaining cleanup",
    async () => {
      const fx = fixture();
      expect(runCli(fx.repo, ["setup"]).status).toBe(0);
      expect(runDev(fx.repo, ["up"]).status).toBe(0);
      const registryFile = join(fx.repo, ".local-wt", "workspace-registry", "dev-servers.json");
      const before: { servers: { pids: Record<string, number> }[] } = JSON.parse(
        readFileSync(registryFile, "utf8"),
      );
      for (const entry of before.servers) {
        for (const pid of Object.values(entry.pids)) ownedPids.add(pid);
      }
      installBarrier(fx, fx.repo, "stop");
      const running = startCli(fx, fx.repo, ["workspace", "teardown", "--json"]);
      const pids = await waitForOwnedCommand(fx);
      running.child.kill("SIGINT");
      await assertInterrupted(running, pids);
      expect(Object.values(readWorkspaces(fx.repo).workspaces)[0].cleanupPending).toBe(true);
      expect(JSON.parse(readFileSync(registryFile, "utf8")).servers).toMatchObject([
        { cleanupPending: true },
      ]);
      writeFileSync(join(fx.root, "release"), "release");
      const retry = runCli(fx.repo, ["teardown"], { INTERRUPT_DIR: fx.root });
      expect(retry.status, retry.stderr).toBe(0);
    },
    TIMEOUT_MS,
  );

  it(
    "cancels target-owned stop commands from a defaults-only down-all caller",
    async () => {
      const fx = fixture();
      const linked = join(fx.root, "linked");
      execFileSync("git", ["worktree", "add", "-b", "linked", linked], { cwd: fx.repo });
      expect(runCli(fx.repo, ["setup", "--path", linked]).status).toBe(0);
      expect(runDev(linked, ["up"]).status).toBe(0);
      const registry = join(fx.repo, ".local-wt/workspace-registry/dev-servers.json");
      const entries: { servers: { pids: Record<string, number> }[] } = JSON.parse(
        readFileSync(registry, "utf8"),
      );
      for (const entry of entries.servers)
        for (const pid of Object.values(entry.pids)) ownedPids.add(pid);
      installBarrier(fx, linked, "stop");
      writeFileSync(join(fx.repo, "alignfirst.json"), '{"schemaVersion":1}');
      const running = startCli(fx, fx.repo, ["dev", "down", "--all"]);
      const pids = await waitForOwnedCommand(fx);
      running.child.kill("SIGINT");
      await assertInterrupted(running, pids);
      expect(JSON.parse(readFileSync(registry, "utf8")).servers).toMatchObject([
        { worktree: linked, cleanupPending: true },
      ]);
      writeFileSync(join(fx.root, "release"), "release");
      const retry = runDev(fx.repo, ["down", "--all"], { INTERRUPT_DIR: fx.root });
      expect(retry.status, retry.stderr).toBe(0);
      expect(JSON.parse(readFileSync(registry, "utf8")).servers).toEqual([]);
    },
    TIMEOUT_MS,
  );

  it(
    "cancels and awaits an owned dev-setup CLI child from ready setup --full",
    async () => {
      const fx = fixture();
      expect(runCli(fx.repo, ["setup"]).status).toBe(0);
      installBarrier(fx, fx.repo, "devSetup");
      const running = startCli(fx, fx.repo, ["workspace", "setup", "--full", "--json"]);
      const pids = await waitForOwnedCommand(fx);
      running.child.kill("SIGINT");
      await assertInterrupted(running, pids);
      expect(existsSync(join(fx.root, "later"))).toBe(false);
      const entry = Object.values(readWorkspaces(fx.repo).workspaces)[0];
      expect(entry.status).toBe("ready");
      expect(entry.devSetupFailure).toBeDefined();
    },
    TIMEOUT_MS,
  );

  it(
    "interrupts only the wait after handing off a deliberately detached finalizer",
    async () => {
      const fx = fixture();
      installBarrier(fx, fx.repo, "finalize");
      const running = startCli(fx, fx.repo, ["workspace", "setup", "--json"]);
      const pids = await waitForOwnedCommand(fx);
      running.child.kill("SIGINT");
      await waitUntil(() => running.closed, "interrupted wait");
      expect(running.code).not.toBe(0);
      expect(pids.every(isAlive)).toBe(true);
      expect(Object.values(readWorkspaces(fx.repo).workspaces)[0].status).toBe("pending");
      writeFileSync(join(fx.root, "release"), "release");
      const joined = runCli(fx.repo, ["wait"]);
      expect(joined.status, joined.stderr).toBe(0);
      await waitUntil(() => pids.every((pid) => !isAlive(pid)), "detached finalization");
      expect(existsSync(join(fx.root, "later"))).toBe(true);
    },
    TIMEOUT_MS,
  );
});

function fixture(options?: FixtureOptions): FixtureRepo {
  const fx = createFixtureRepo(options);
  fixtures.push(fx);
  return fx;
}

function installBarrier(
  fx: FixtureRepo,
  worktree: string,
  phase: "preSetup" | "finalize" | "purge" | "devSetup" | "stop",
): void {
  const file = join(worktree, "alignfirst.json");
  const manifest: WorkspaceManifest = JSON.parse(readFileSync(file, "utf8"));
  const steps = [
    {
      name: "owned-command",
      run: [cliExecutable, "scripts/interrupt.mjs"],
      ...(phase === "purge" ? { continueOnError: true } : {}),
    },
    {
      name: "must-not-run-after-interruption",
      run: [
        cliExecutable,
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(join(fx.root, "later"))}, 'later')`,
      ],
    },
  ];
  if (phase === "stop") {
    const server = manifest.devServer?.servers.find((server) => server.kind === "command");
    if (server?.kind !== "command") throw new Error("Fixture needs a command service");
    server.stop = { run: [cliExecutable, "scripts/interrupt.mjs"] };
  } else if (phase === "devSetup") {
    if (!manifest.devServer) throw new Error("Fixture needs dev services");
    manifest.devServer.setup = steps;
  } else {
    manifest.workspace ??= {};
    manifest.workspace[phase] = steps;
  }
  writeFileSync(file, JSON.stringify(manifest));
  writeFileSync(
    join(worktree, "scripts/interrupt.mjs"),
    `
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
const dir = process.env.INTERRUPT_DIR;
writeFileSync(join(dir, "pids.json"), JSON.stringify([process.pid, child.pid]));
while (!existsSync(join(dir, "release"))) await new Promise((resolve) => setTimeout(resolve, 25));
const closed = once(child, "close");
child.kill("SIGTERM");
await closed;
`,
  );
}

function startCli(fx: FixtureRepo, cwd: string, args: string[]): RunningChild {
  const child = spawn(cliExecutable, [alignfirstBin, ...args], {
    cwd,
    env: { ...process.env, HOME: join(fx.root, "home"), INTERRUPT_DIR: fx.root },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const running: RunningChild = { child, closed: false, code: null, output: "" };
  child.stdout?.on("data", (chunk) => {
    running.output += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    running.output += chunk.toString();
  });
  child.on("close", (code) => {
    running.closed = true;
    running.code = code;
  });
  children.push(running);
  return running;
}

async function waitForOwnedCommand(fx: FixtureRepo): Promise<number[]> {
  const file = join(fx.root, "pids.json");
  await waitUntil(() => existsSync(file), "owned command launch");
  const pids: number[] = JSON.parse(readFileSync(file, "utf8"));
  for (const pid of pids) ownedPids.add(pid);
  return pids;
}

async function assertInterrupted(running: RunningChild, pids: number[]): Promise<void> {
  await waitUntil(() => running.closed, "cancelled CLI exit");
  expect(running.code, running.output).not.toBe(0);
  expect(pids.filter(isAlive), running.output).toEqual([]);
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function isAlive(pid: number): boolean {
  try {
    if (readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.startsWith("Z")) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
