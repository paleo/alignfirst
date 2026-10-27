import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { WorkspaceManifest } from "../../src/config.js";
import {
  alignfirstBin,
  cliExecutable,
  createFixtureRepo,
  type FixtureRepo,
  readWorkspaces,
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
    if (Object.values(entries).some((entry) => entry.status === "pending")) {
      const result = runCli(fx.repo, ["wait"]);
      expect(result.status, result.stderr).toBe(0);
    }
    rmSync(fx.root, { recursive: true, force: true });
  }
});

describe("installed workspace CLI cancellation", () => {
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

  it.each(["teardown", "removeHere"])(
    "retains interrupted target-owned purge through %s, including internal re-exec cleanup",
    async (command) => {
      const fx = fixture();
      const linked = join(fx.root, "linked");
      execFileSync("git", ["worktree", "add", "-b", "linked", linked], { cwd: fx.repo });
      expect(runCli(fx.repo, ["setup", "--path", linked]).status).toBe(0);
      installBarrier(fx, linked, "purge");
      const cwd = command === "removeHere" ? linked : fx.repo;
      const args =
        command === "removeHere"
          ? ["workspace", "remove", "--force", "--json"]
          : ["workspace", "teardown", linked, "--json"];
      const running = startCli(fx, cwd, args);
      const pids = await waitForOwnedCommand(fx);
      running.child.kill("SIGTERM");
      await assertInterrupted(running, pids);
      expect(existsSync(join(fx.root, "later"))).toBe(false);
      expect(existsSync(linked)).toBe(true);
      const retained = Object.values(readWorkspaces(fx.repo).workspaces).find(
        (entry) => entry.worktree === linked,
      );
      expect(retained?.cleanupPending).toBe(true);
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
      writeFileSync(join(fx.repo, "alignfirst-workspace.json"), '{"schemaVersion":1}');
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

function fixture(): FixtureRepo {
  const fx = createFixtureRepo();
  fixtures.push(fx);
  return fx;
}

function installBarrier(
  fx: FixtureRepo,
  worktree: string,
  phase: "preSetup" | "finalize" | "purge" | "devSetup" | "stop",
): void {
  const file = join(worktree, "alignfirst-workspace.json");
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
import { existsSync, writeFileSync } from "node:fs";
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
