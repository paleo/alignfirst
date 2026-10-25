import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const packageRoot = resolve(import.meta.dirname, "..");
const cli = join(packageRoot, "bin", "cli.mjs");
const bun = process.env.BUN_BIN;
const runtimes = bun === undefined ? [process.execPath] : [process.execPath, bun];
const RUN_CASE = ["run", "--channel", "mock", "--model", "offline", "case"];
const roots: string[] = [];
const children: ChildProcess[] = [];

if (bun !== undefined && !existsSync(bun)) throw new Error(`Missing BUN_BIN: ${bun}`);

// Each lifecycle case starts several real CLIs, beyond the unit-test 5s default.
vi.setConfig({ testTimeout: 30_000 });

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      try {
        await waitUntil(() => child.exitCode !== null || child.signalCode !== null);
      } catch {
        child.kill("SIGKILL");
        await waitUntil(() => child.exitCode !== null || child.signalCode !== null);
      }
    }
  }
  for (const root of roots.splice(0)) {
    for (const record of records({ log: join(root, "project", "docker.jsonl") })) {
      for (const pid of [record.pid, record.worker]) {
        if (pid === undefined) continue;
        if (alive(pid)) process.kill(pid, "SIGKILL");
        await waitUntil(() => !alive(pid));
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

describe.each(runtimes)("built harness with %s", (runtime) => {
  it.each([{ args: ["--help"] }, { args: ["run"] }, { args: ["env", "oops"] }])(
    "renders usage and recovery for $args without losing the runtime",
    ({ args }) => {
      const fixture = consumer();
      const result = run(runtime, fixture, args);
      expect(result.status, result.stderr).toBe(1);
      const command = runtime === bun ? "bunx --bun @alignfirst/openclaw-test" : "openclaw-test";
      expect(result.stderr).toContain(`usage: ${command}`);
      if (args[0] === "run") expect(result.stderr).toContain(`${command} env up`);
    },
  );

  it("retains the package-runner recovery form", () => {
    const fixture = consumer();
    const result = run(runtime, fixture, ["run", "--channel"], {
      npm_config_user_agent: "npm/1.0.0",
      npm_command: "exec",
    });
    const command =
      runtime === bun ? "bunx --bun @alignfirst/openclaw-test" : "npx -y @alignfirst/openclaw-test";
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`usage: ${command} run`);
    expect(result.stderr).toContain(`${command} env up`);
  });

  it("initializes idempotent local scripts and gives concrete npm container preparation", () => {
    const fixture = consumer();
    const result = run(runtime, fixture, ["init", fixture.root]);
    expect(result.status, result.stderr).toBe(0);
    const pkg = JSON.parse(readFileSync(join(fixture.root, "package.json"), "utf8"));
    if (runtime === bun) {
      expect(pkg.scripts.e2e).toBe("bun ./node_modules/.bin/openclaw-test run");
      expect(result.stdout).toContain('docker run --rm --user "$(id -u):$(id -g)"');
      expect(result.stdout).toContain('-v "$PWD:/app" -w /app node:26 npm install -D');
      expect(result.stdout).toContain("bun --bun run env:build");
    } else expect(pkg.scripts.e2e).toBe("openclaw-test run");
    expect(run(runtime, fixture, ["init", fixture.root]).stdout).toContain(
      "scripts already present",
    );
    rmSync(join(fixture.root, "package.json"));
    const missing = run(runtime, fixture, ["init", fixture.root]);
    expect(missing.stdout).toContain(runtime === bun ? "`bun init`" : "`npm init`");
  });

  it("executes env down, preserves Docker argv/env and propagates nonzero recreate exits", () => {
    const fixture = consumer();
    expect(run(runtime, fixture, ["env", "down"]).status).toBe(0);
    const failed = run(runtime, fixture, RUN_CASE, { FAKE_FAIL_UP: "7" });
    expect(failed.status, failed.stderr).toBe(7);
    expect(failed.stderr).toContain("fake recreate failure");
    const calls = records(fixture);
    const up = calls.find((call) => call.args?.includes("up"));
    expect(up?.args?.slice(-6)).toEqual([
      "up",
      "-d",
      "--force-recreate",
      "--wait",
      "bus",
      "gateway",
    ]);
    expect(up?.workspace).toBe(join(fixture.root, ".workers", "w1", "workspace"));
    expect(up?.config).toContain("openclaw-test-config-");
    expect(up?.uid).toBe(String(process.getuid?.() ?? 1000));
    expect(calls.some((call) => call.args?.at(-1) === "down")).toBe(true);
    expect(existsSync(up?.config ?? "missing")).toBe(false);
  });

  it.each([1, 2])(
    "joins serial/captured output and deterministic result files (%i workers)",
    (parallel) => {
      const fixture = consumer();
      const result = run(runtime, fixture, [
        "run",
        "--channel",
        "mock",
        "--model",
        "offline",
        "--parallel",
        String(parallel),
        "first",
        "second",
      ]);
      expect(result.status, result.stderr).toBe(0);
      if (parallel === 1) {
        expect(result.stdout).toContain("FAKE_RUN_STDOUT");
        expect(result.stderr).toContain("FAKE_RUN_STDERR");
      } else {
        const stamp = readdirSync(join(fixture.root, "artifacts"))[0];
        const log = readFileSync(
          join(fixture.root, "artifacts", stamp, "cells", "offline-first-mock.log"),
          "utf8",
        );
        expect(log).toContain("FAKE_RUN_STDOUT");
        expect(log).toContain("FAKE_RUN_STDERR");
      }
      const downs = records(fixture).filter((call) => call.args?.at(-1) === "down");
      expect(downs).toHaveLength(parallel);
    },
  );

  it("cancels a running cell, escalates its Docker children and still tears down", async () => {
    const fixture = consumer();
    const started = start(runtime, fixture, RUN_CASE, { FAKE_HANG: "run", FAKE_FAIL_DOWN: "9" });
    await waitUntil(() => started.output().includes("FAKE_RUNNING"));
    started.child.kill("SIGTERM");
    await started.closed;
    expect(started.child.exitCode, started.output()).toBe(143);
    expect(records(fixture).at(-1)?.args?.at(-1)).toBe("down");
    await waitForOwnedProcesses(fixture);
  });

  it.each([
    { mode: "parallel", signal: "SIGINT" },
    { mode: "partial", signal: "SIGTERM" },
    { mode: "mixed", signal: "SIGINT" },
    { mode: "matrixFailure", signal: "SIGTERM" },
  ] as const)(
    "retains $signal during final teardown and joins every owned worker ($mode)",
    async ({ mode, signal }) => {
      const fixture = consumer();
      const started = start(
        runtime,
        fixture,
        ["run", "--channel", "mock", "--model", "offline", "--parallel", "2", "first", "second"],
        {
          FAKE_HANG: "down",
          FAKE_REMOVE_BEFORE_DOWN: "1",
          ...(mode === "partial" || mode === "mixed" ? { FAKE_HANG_WORKER: "2" } : {}),
          ...(mode === "mixed" ? { FAKE_FAIL_DOWN: "9" } : {}),
          ...(mode === "matrixFailure" ? { FAKE_FAIL_UP: "7" } : {}),
        },
      );
      const hanging = mode === "partial" || mode === "mixed" ? 1 : 2;
      await waitUntil(() => started.output().split("FAKE_RUNNING").length - 1 === hanging);
      const calls = records(fixture);
      const configs = configPaths(fixture);
      expect(configs).toHaveLength(1);
      started.child.kill(signal);
      await started.closed;
      expect(started.child.exitCode, started.output()).toBe(
        mode === "matrixFailure" ? 7 : signal === "SIGINT" ? 130 : 143,
      );
      expect(calls.filter((call) => call.args?.at(-1) === "down")).toHaveLength(2);
      for (const config of configs) expect(existsSync(config)).toBe(true);
      expect(run(runtime, fixture, ["env", "down"]).status).toBe(0);
      for (const config of configs) expect(existsSync(config)).toBe(false);
      await waitForOwnedProcesses(fixture);
    },
  );

  it("prioritizes a signal over a failed sibling during parallel env up", async () => {
    const fixture = consumer();
    const started = start(runtime, fixture, ["env", "up", "--parallel", "2"], {
      FAKE_HANG: "up",
      FAKE_HANG_WORKER: "2",
      FAKE_FAIL_UP: "7",
    });
    await waitUntil(() => started.output().includes("FAKE_RUNNING"));
    const ups = records(fixture).filter((call) => call.args?.includes("up"));
    expect(ups).toHaveLength(2);
    const failed = ups.find((call) => call.args?.includes("project-w1"));
    expect(failed?.pid).toBeDefined();
    await waitUntil(() => failed?.pid !== undefined && !alive(failed.pid));
    expect(started.output()).toContain("fake recreate failure");
    started.child.kill("SIGINT");
    await started.closed;
    expect(started.child.exitCode, started.output()).toBe(130);
    await waitForOwnedProcesses(fixture);
    const config = lastConfigPath(fixture);
    expect(existsSync(config)).toBe(true);
    expect(run(runtime, fixture, ["env", "down"]).status).toBe(0);
    expect(existsSync(config)).toBe(false);
  });

  it.each([
    { command: "down", mode: "parallel", signal: "SIGINT" },
    { command: "rebuild", mode: "mixed", signal: "SIGTERM" },
  ] as const)(
    "cancels the env $command sweep on $signal without collecting warm configs ($mode)",
    async ({ command, mode, signal }) => {
      const fixture = consumer();
      expect(run(runtime, fixture, ["env", "up", "--parallel", "2"]).status).toBe(0);
      const config = lastConfigPath(fixture);
      const started = start(runtime, fixture, command === "down" ? ["env", "down"] : RUN_CASE, {
        FAKE_HANG: "down",
        // Remove every mount before cancellation to expose premature config collection.
        FAKE_REMOVE_BEFORE_DOWN: "1",
        ...(command === "rebuild" ? { FAKE_BASE_MISSING: "1" } : {}),
        ...(mode === "mixed" ? { FAKE_HANG_WORKER: "2", FAKE_FAIL_DOWN: "9" } : {}),
      });
      const hanging = mode === "mixed" ? 1 : 2;
      await waitUntil(() => started.output().split("FAKE_RUNNING").length - 1 === hanging);
      const downs = records(fixture).filter((call) => call.args?.at(-1) === "down");
      expect(downs.map((call) => call.args?.[call.args.indexOf("-p") + 1]).sort()).toEqual([
        "project-w1",
        "project-w2",
      ]);
      if (mode === "mixed") {
        const failed = downs.find((call) => call.args?.includes("project-w1"));
        expect(failed?.pid).toBeDefined();
        await waitUntil(() => failed?.pid !== undefined && !alive(failed.pid));
      }
      started.child.kill(signal);
      await started.closed;
      expect(started.child.exitCode, started.output()).toBe(signal === "SIGINT" ? 130 : 143);
      const calls = records(fixture);
      expect(calls.filter((call) => call.worker !== undefined)).toHaveLength(hanging);
      await waitForOwnedProcesses(fixture);
      expect(configPaths(fixture)).toEqual([config]);
      expect(calls.some((call) => call.args?.includes("run"))).toBe(false);
      expect(existsSync(config)).toBe(true);
      expect(run(runtime, fixture, ["env", "down"]).status).toBe(0);
      expect(existsSync(config)).toBe(false);
    },
  );

  it.each([0, 7])("preserves matrix exit %i across a failing teardown", (matrixExit) => {
    const fixture = consumer();
    const result = run(runtime, fixture, RUN_CASE, {
      FAKE_FAIL_DOWN: "9",
      FAKE_REMOVE_BEFORE_DOWN: "1",
      ...(matrixExit === 7 ? { FAKE_FAIL_UP: "7" } : {}),
    });
    expect(result.status, result.stderr).toBe(matrixExit === 0 ? 9 : matrixExit);
    const config = configPaths(fixture).at(-1);
    expect(config).toBeDefined();
    expect(existsSync(config ?? "missing")).toBe(true);
    expect(run(runtime, fixture, ["env", "down"]).status).toBe(0);
    expect(existsSync(config ?? "missing")).toBe(false);
  });

  it("keeps warm configs across repeated runs and collects superseded secrets", () => {
    const fixture = consumer();
    expect(run(runtime, fixture, ["env", "up"]).status).toBe(0);
    const first = lastConfigPath(fixture);
    expect(existsSync(first)).toBe(true);
    expect(statSync(first).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(first)).mode & 0o777).toBe(0o700);
    expect(statSync(dirname(dirname(first))).mode & 0o777).toBe(0o700);
    expect(statSync(dirname(dirname(dirname(first)))).mode & 0o777).toBe(0o700);
    expect(statSync(join(dirname(first), "owner.json")).mode & 0o777).toBe(0o600);
    expect(first.startsWith(`${fixture.env.XDG_STATE_HOME}/openclaw-test/`)).toBe(true);
    expect(readFileSync(first, "utf8")).toContain("private-test-secret");
    expect(first.startsWith(fixture.root)).toBe(false);
    expect(run(runtime, fixture, RUN_CASE).status).toBe(0);
    const second = lastConfigPath(fixture);
    expect(second).not.toBe(first);
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(true);
    expect(run(runtime, fixture, RUN_CASE).status).toBe(0);
    const third = lastConfigPath(fixture);
    expect(existsSync(second)).toBe(false);
    expect(existsSync(third)).toBe(true);
    expect(records(fixture).filter((call) => call.args?.at(-1) === "down")).toHaveLength(0);
    expect(run(runtime, fixture, ["env", "down"]).status).toBe(0);
    expect(existsSync(third)).toBe(false);
  });

  it.each(["XDG_STATE_HOME", "HOME fallback", "symlinked ancestor"])(
    "discovers %s configs across TMPDIR changes",
    (location) => {
      const fixture = consumer();
      if (location === "HOME fallback") fixture.env.XDG_STATE_HOME = "";
      if (location === "symlinked ancestor") {
        const physical = join(dirname(fixture.root), "physical-state");
        const linked = join(dirname(fixture.root), "linked-parent");
        mkdirSync(physical, { mode: 0o700 });
        symlinkSync(physical, linked);
        fixture.env.XDG_STATE_HOME = join(linked, "state");
      }
      const temps = ["up-tmp", "run-tmp", "down-tmp"].map((name) =>
        join(dirname(fixture.root), name),
      );
      for (const temp of temps) mkdirSync(temp);
      expect(run(runtime, fixture, ["env", "up"], { TMPDIR: temps[0] }).status).toBe(0);
      const first = lastConfigPath(fixture);
      rmSync(temps[0], { recursive: true });
      expect(existsSync(first)).toBe(true);
      const result = run(runtime, fixture, RUN_CASE, { TMPDIR: temps[1] });
      expect(result.status, result.stderr).toBe(0);
      const second = lastConfigPath(fixture);
      expect(second).not.toBe(first);
      expect(dirname(dirname(first))).toBe(dirname(dirname(second)));
      expect(existsSync(first)).toBe(false);
      expect(existsSync(second)).toBe(true);
      expect(records(fixture).filter((call) => call.args?.at(-1) === "down")).toHaveLength(0);
      rmSync(temps[1], { recursive: true });
      expect(run(runtime, fixture, ["env", "down"], { TMPDIR: temps[2] }).status).toBe(0);
      for (const config of configPaths(fixture)) expect(existsSync(config)).toBe(false);
    },
  );

  it("joins and removes only new workers in a mixed warm/new run", () => {
    const fixture = consumer();
    expect(run(runtime, fixture, ["env", "up"]).status).toBe(0);
    const result = run(runtime, fixture, [
      "run",
      "--channel",
      "mock",
      "--model",
      "offline",
      "--parallel",
      "2",
      "first",
      "second",
    ]);
    expect(result.status, result.stderr).toBe(0);
    const downs = records(fixture).filter((call) => call.args?.at(-1) === "down");
    expect(downs).toHaveLength(1);
    expect(downs[0]?.args?.[downs[0].args.indexOf("-p") + 1]).toMatch(/-w2$/);
    const config = lastConfigPath(fixture);
    expect(existsSync(config)).toBe(true);
    expect(run(runtime, fixture, ["env", "down"]).status).toBe(0);
    expect(existsSync(config)).toBe(false);
  });

  it.each(["FAKE_FAIL_PS", "FAKE_FAIL_INSPECT", "FAKE_MALFORMED_INSPECT"])(
    "retains configs when mount discovery is uncertain (%s)",
    (failure) => {
      const fixture = consumer();
      expect(run(runtime, fixture, ["env", "up"]).status).toBe(0);
      const first = lastConfigPath(fixture);
      expect(
        run(runtime, fixture, RUN_CASE, {
          [failure]: "1",
        }).status,
      ).toBe(0);
      expect(existsSync(first)).toBe(true);
      expect(run(runtime, fixture, ["env", "down"]).status).toBe(0);
      for (const path of configPaths(fixture)) expect(existsSync(path)).toBe(false);
    },
  );

  it("retains stopped and external container references after successful down", () => {
    const fixture = consumer();
    expect(run(runtime, fixture, ["env", "up"]).status).toBe(0);
    const config = lastConfigPath(fixture);
    const stateDir = join(fixture.root, "docker-state");
    const stateName = readdirSync(stateDir)[0];
    if (stateName === undefined) throw new Error("Missing container state");
    const stateFile = join(stateDir, stateName);
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    state.running = false;
    writeFileSync(stateFile, JSON.stringify(state));
    expect(run(runtime, fixture, ["env", "down"], { FAKE_KEEP_CONTAINERS: "1" }).status).toBe(0);
    expect(existsSync(config)).toBe(true);
    // A stopped unrelated container can also reference the config's parent directory.
    writeFileSync(
      join(stateDir, "external.json"),
      JSON.stringify({
        Id: "external",
        project: "external",
        running: false,
        Mounts: [{ Type: "bind", Source: dirname(config) }],
      }),
    );
    expect(run(runtime, fixture, ["env", "down"]).status).toBe(0);
    expect(existsSync(config)).toBe(true);
    rmSync(join(stateDir, "external.json"));
    expect(run(runtime, fixture, ["env", "down"]).status).toBe(0);
    expect(existsSync(config)).toBe(false);
  });

  it("sweeps warm configs on rebuild before creating and removing new workers", () => {
    const fixture = consumer();
    expect(run(runtime, fixture, ["env", "up", "--parallel", "2"]).status).toBe(0);
    const old = lastConfigPath(fixture);
    const result = run(runtime, fixture, RUN_CASE, { FAKE_BASE_MISSING: "1" });
    expect(result.status, result.stderr).toBe(0);
    const downs = records(fixture).filter((call) => call.args?.at(-1) === "down");
    expect(downs).toHaveLength(3);
    expect(existsSync(old)).toBe(false);
    for (const path of configPaths(fixture)) expect(existsSync(path)).toBe(false);
  });

  it("retains secrets and aborts rebuild when the warm sweep fails", () => {
    const fixture = consumer();
    expect(run(runtime, fixture, ["env", "up"]).status).toBe(0);
    const config = lastConfigPath(fixture);
    const result = run(runtime, fixture, RUN_CASE, { FAKE_BASE_MISSING: "1", FAKE_FAIL_DOWN: "9" });
    expect(result.status).toBe(9);
    expect(existsSync(config)).toBe(true);
    expect(configPaths(fixture)).toEqual([config]);
    expect(run(runtime, fixture, ["env", "down"]).status).toBe(0);
    expect(existsSync(config)).toBe(false);
  });

  it("collects only configs with matching ownership", () => {
    const fixture = consumer();
    const sibling = consumer();
    sibling.env.XDG_STATE_HOME = fixture.env.XDG_STATE_HOME;
    expect(run(runtime, fixture, ["env", "up"]).status).toBe(0);
    expect(run(runtime, sibling, ["env", "up"]).status).toBe(0);
    const own = lastConfigPath(fixture);
    const other = lastConfigPath(sibling);
    expect(dirname(dirname(own))).not.toBe(dirname(dirname(other)));
    writeFileSync(
      join(dirname(own), "owner.json"),
      JSON.stringify({
        projectDir: sibling.root,
        pid: 99999999,
      }),
    );
    expect(run(runtime, fixture, ["env", "down"]).status).toBe(0);
    expect(existsSync(own)).toBe(true);
    expect(existsSync(other)).toBe(true);
    expect(run(runtime, sibling, ["env", "down"]).status).toBe(0);
    expect(existsSync(other)).toBe(false);
  });

  it("retains another live command's unmounted configs", () => {
    const fixture = consumer();
    expect(run(runtime, fixture, ["env", "up"]).status).toBe(0);
    const config = lastConfigPath(fixture);
    const ownerFile = join(dirname(config), "owner.json");
    const owner = JSON.parse(readFileSync(ownerFile, "utf8"));
    writeFileSync(ownerFile, JSON.stringify({ ...owner, pid: process.pid }));
    expect(run(runtime, fixture, ["env", "down"]).status).toBe(0);
    expect(existsSync(config)).toBe(true);
    writeFileSync(ownerFile, JSON.stringify(owner));
    expect(run(runtime, fixture, ["env", "down"]).status).toBe(0);
    expect(existsSync(config)).toBe(false);
  });

  it("does not collect configs owned by a different Docker daemon", () => {
    const fixture = consumer();
    expect(run(runtime, fixture, ["env", "up"]).status).toBe(0);
    const config = lastConfigPath(fixture);
    expect(run(runtime, fixture, ["env", "down"], { FAKE_DAEMON_ID: "other" }).status).toBe(0);
    expect(existsSync(config)).toBe(true);
    expect(run(runtime, fixture, ["env", "down"]).status).toBe(0);
    expect(existsSync(config)).toBe(false);
  });

  it("retains configs when project discovery or daemon identification fails", () => {
    const fixture = consumer();
    expect(run(runtime, fixture, ["env", "up"]).status).toBe(0);
    const config = lastConfigPath(fixture);
    expect(run(runtime, fixture, ["env", "down"], { FAKE_FAIL_LS: "1" }).status).toBe(1);
    expect(existsSync(config)).toBe(true);
    expect(run(runtime, fixture, ["env", "down"], { FAKE_FAIL_INFO: "1" }).status).toBe(0);
    expect(existsSync(config)).toBe(true);
    expect(run(runtime, fixture, ["env", "down"]).status).toBe(0);
    expect(existsSync(config)).toBe(false);
  });

  it.each(["direct", "symlink"])("rejects %s state root inside the build context", (kind) => {
    const fixture = consumer();
    const privateState = join(fixture.root, "private-state");
    mkdirSync(privateState);
    let stateHome = privateState;
    if (kind === "symlink") {
      stateHome = join(dirname(fixture.root), "linked-state");
      symlinkSync(privateState, stateHome);
    }
    const result = run(runtime, fixture, ["env", "up"], { XDG_STATE_HOME: stateHome });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("state root must be outside");
    expect(readdirSync(privateState)).toEqual([]);
  });

  it.each(["relative", "symlink", "public", "writable"])(
    "rejects an unsafe %s state directory",
    (kind) => {
      const fixture = consumer();
      const stateHome = fixture.env.XDG_STATE_HOME;
      const home = fixture.env.HOME;
      if (stateHome === undefined || home === undefined) {
        throw new Error("Missing isolated state home");
      }
      mkdirSync(stateHome, { recursive: true, mode: 0o700 });
      const appRoot = join(stateHome, "openclaw-test");
      if (kind === "symlink") symlinkSync(home, appRoot);
      if (kind === "public") mkdirSync(appRoot, { mode: 0o755 });
      if (kind === "writable") chmodSync(stateHome, 0o777);
      const result = run(runtime, fixture, ["env", "up"], {
        XDG_STATE_HOME: kind === "relative" ? "relative-state" : stateHome,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(kind === "relative" ? "must be absolute" : "unsafe");
      expect(configPaths(fixture)).toEqual([]);
    },
  );

  it("imports offline runner/helpers and reads real SQLite plus zstd", () => {
    const result = spawnSync(
      runtime,
      [join(packageRoot, "test", "fixtures", "runtime-helpers.mjs")],
      { encoding: "utf8", timeout: 20_000 },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("SQLITE_ZSTD_OK");
  });

  it("starts and stops the installed bus graph", async () => {
    const fixture = consumer();
    const child = spawn(runtime, [cli, "bus"], {
      cwd: fixture.root,
      env: fixture.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let output = "";
    child.stdout?.on("data", (data) => {
      output += data.toString();
    });
    child.stderr?.on("data", (data) => {
      output += data.toString();
    });
    try {
      await waitUntil(() => output.includes("bus listening"));
    } finally {
      child.kill("SIGTERM");
      await waitUntil(() => child.exitCode !== null || child.signalCode !== null);
    }
  });
});

interface Consumer {
  root: string;
  log: string;
  env: NodeJS.ProcessEnv;
}

interface DockerRecord {
  args?: string[];
  pid?: number;
  worker?: number;
  config?: string;
  workspace?: string;
  uid?: string;
}

function consumer(): Consumer {
  const sandbox = mkdtempSync(join(tmpdir(), "harness-built-"));
  roots.push(sandbox);
  const root = join(sandbox, "project");
  const home = join(sandbox, "home");
  mkdirSync(root);
  mkdirSync(home, { mode: 0o700 });
  const bin = join(root, "bin");
  mkdirSync(bin);
  const docker = join(bin, "docker");
  writeFileSync(
    docker,
    `#!${process.execPath}\n${readFileSync(join(packageRoot, "test", "fixtures", "fake-docker.mjs"), "utf8")}`,
  );
  chmodSync(docker, 0o755);
  writeFileSync(join(root, "package.json"), "{}");
  writeFileSync(
    join(root, "openclaw.json"),
    JSON.stringify({
      channels: { mock: {} },
      agents: { entries: { main: {} } },
      // biome-ignore lint/suspicious/noTemplateCurlyInString: exercise config interpolation
      testSecret: "${HARNESS_PRIVATE_TEST_KEY}",
    }),
  );
  mkdirSync(join(root, "workspace"));
  mkdirSync(join(root, "scenarios"));
  for (const scenario of ["case", "first", "second"]) {
    writeFileSync(join(root, "scenarios", `${scenario}.ts`), "export default async () => {};\n");
  }
  const log = join(root, "docker.jsonl");
  writeFileSync(log, "");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: join(home, "state"),
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    FAKE_DOCKER_LOG: log,
    OPENCLAW_WORKSPACE_DIR: join(root, "workspace"),
    OPENCLAW_TEST_PROJECT_DIR: root,
    OPENCLAW_TEST_MODELS: "local/offline",
    HARNESS_PRIVATE_TEST_KEY: "private-test-secret",
  };
  for (const key of [
    "npm_config_user_agent",
    "npm_execpath",
    "npm_command",
    "npm_lifecycle_event",
    "npm_lifecycle_script",
    "npm_package_json",
  ])
    delete env[key];
  return { root, log, env };
}

function run(
  runtime: string,
  fixture: Consumer,
  args: string[],
  extra: Record<string, string> = {},
) {
  return spawnSync(runtime, [cli, ...args], {
    cwd: fixture.root,
    env: { ...fixture.env, ...extra },
    encoding: "utf8",
    timeout: 25_000,
  });
}

interface StartedCli {
  child: ChildProcess;
  output(): string;
  closed: Promise<void>;
}

function start(
  runtime: string,
  fixture: Consumer,
  args: string[],
  extra: Record<string, string>,
): StartedCli {
  const child = spawn(runtime, [cli, ...args], {
    cwd: fixture.root,
    env: { ...fixture.env, ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  child.stdout?.on("data", (data) => {
    output += data.toString();
  });
  child.stderr?.on("data", (data) => {
    output += data.toString();
  });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  return { child, output: () => output, closed };
}

async function waitForOwnedProcesses(fixture: Consumer): Promise<void> {
  for (const call of records(fixture)) {
    for (const pid of [call.pid, call.worker]) {
      if (pid !== undefined) await waitUntil(() => !alive(pid));
    }
  }
}

function lastConfigPath(fixture: Consumer): string {
  const path = configPaths(fixture).at(-1);
  if (path === undefined) throw new Error("Missing rendered config in Docker calls");
  return path;
}

function configPaths(fixture: Consumer): string[] {
  return [
    ...new Set(
      records(fixture)
        .filter((call) => call.args?.includes("up"))
        .map((call) => call.config)
        .filter((path): path is string => path !== undefined),
    ),
  ];
}

function records(fixture: Pick<Consumer, "log">): DockerRecord[] {
  return readFileSync(fixture.log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitUntil(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for owned child");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
