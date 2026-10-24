import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const packageRoot = resolve(import.meta.dirname, "..");
const cli = join(packageRoot, "bin", "cli.mjs");
const bun = process.env.BUN_BIN;
const runtimes = bun === undefined ? [process.execPath] : [process.execPath, bun];
const roots: string[] = [];
const children: ChildProcess[] = [];

if (bun !== undefined && !existsSync(bun)) throw new Error(`Missing BUN_BIN: ${bun}`);

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
    for (const record of records({ log: join(root, "docker.jsonl") })) {
      for (const pid of [record.pid, record.worker]) {
        if (pid === undefined) continue;
        if (alive(pid)) process.kill(pid, "SIGKILL");
        await waitUntil(() => !alive(pid));
      }
      if (record.config?.startsWith(join(tmpdir(), "openclaw-test-config-"))) {
        rmSync(dirname(record.config), { recursive: true, force: true });
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

describe.each(runtimes)("built harness with %s", (runtime) => {
  it("renders usage, malformed run and env recovery without losing the runtime", () => {
    const fixture = consumer();
    for (const args of [
      ["--help"],
      ["run"],
      ["run", "--channel"],
      ["run", "--bogus"],
      ["env", "oops"],
    ]) {
      const result = run(runtime, fixture, args);
      expect(result.status, result.stderr).toBe(1);
      const command = runtime === bun ? "bunx --bun @alignfirst/openclaw-test" : "openclaw-test";
      expect(result.stderr).toContain(`usage: ${command}`);
      if (args[0] === "run") expect(result.stderr).toContain(`${command} env up`);
    }
  });

  it.each(["npm", "bun"])("retains %s package-runner recovery forms", (manager) => {
    const fixture = consumer();
    const result = run(runtime, fixture, ["run", "--channel"], {
      npm_config_user_agent: `${manager}/1.0.0`,
      npm_command: "exec",
    });
    const command =
      runtime === bun
        ? "bunx --bun @alignfirst/openclaw-test"
        : manager === "npm"
          ? "npx -y @alignfirst/openclaw-test"
          : "bunx @alignfirst/openclaw-test";
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
    const failed = run(
      runtime,
      fixture,
      ["run", "--channel", "mock", "--model", "offline", "case"],
      { FAKE_FAIL_UP: "7" },
    );
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
    expect(calls.at(-1)?.args?.at(-1)).toBe("down");
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

  it.each(["run", "env"])(
    "cancels and escalates owned Docker children during %s",
    async (command) => {
      const fixture = consumer();
      const args =
        command === "run"
          ? ["run", "--channel", "mock", "--model", "offline", "case"]
          : ["env", "up"];
      const child = spawn(runtime, [cli, ...args], {
        cwd: fixture.root,
        env: {
          ...fixture.env,
          FAKE_HANG: command === "run" ? "run" : "up",
          FAKE_FAIL_DOWN: "9",
        },
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
        await waitUntil(() => output.includes("FAKE_RUNNING"));
        child.kill("SIGTERM");
        await waitUntil(() => child.exitCode !== null || child.signalCode !== null);
        expect(child.exitCode, output).toBe(143);
        const calls = records(fixture);
        if (command === "run") expect(calls.at(-1)?.args?.at(-1)).toBe("down");
        for (const call of calls) {
          for (const pid of [call.pid, call.worker]) {
            if (pid !== undefined) await waitUntil(() => !alive(pid));
          }
        }
      } finally {
        // Cleanup remains owned even when an assertion fails.
        for (const call of records(fixture)) {
          for (const pid of [call.pid, call.worker]) {
            if (pid !== undefined && alive(pid)) process.kill(pid, "SIGKILL");
          }
        }
      }
    },
    20_000,
  );

  it.each(["SIGINT", "SIGTERM"] as const)(
    "retains %s during final teardown and joins every owned worker",
    async (signal) => {
      for (const mode of ["serial", "parallel", "partial", "mixed", "matrixFailure"]) {
        const fixture = consumer();
        const parallel = mode === "serial" ? 1 : 2;
        const child = spawn(
          runtime,
          [
            cli,
            "run",
            "--channel",
            "mock",
            "--model",
            "offline",
            "--parallel",
            String(parallel),
            "first",
            "second",
          ],
          {
            cwd: fixture.root,
            env: {
              ...fixture.env,
              FAKE_HANG: "down",
              ...(mode === "partial" || mode === "mixed" ? { FAKE_HANG_WORKER: "2" } : {}),
              ...(mode === "mixed" ? { FAKE_FAIL_DOWN: "9" } : {}),
              ...(mode === "matrixFailure" ? { FAKE_FAIL_UP: "7" } : {}),
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        children.push(child);
        let output = "";
        child.stdout?.on("data", (data) => {
          output += data.toString();
        });
        child.stderr?.on("data", (data) => {
          output += data.toString();
        });
        const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
        const hanging = mode === "partial" || mode === "mixed" ? 1 : parallel;
        await waitUntil(() => output.split("FAKE_RUNNING").length - 1 === hanging);
        const calls = records(fixture);
        const configs = new Set(
          calls
            .map((call) => call.config)
            .filter((path): path is string => path?.includes("openclaw-test-config-") === true),
        );
        expect(configs.size).toBe(1);
        for (const config of configs) expect(existsSync(config)).toBe(true);
        child.kill(signal);
        await waitUntil(() => child.exitCode !== null || child.signalCode !== null);
        await closed;
        expect(child.exitCode, `${mode}: ${output}`).toBe(
          mode === "matrixFailure" ? 7 : signal === "SIGINT" ? 130 : 143,
        );
        expect(calls.filter((call) => call.args?.at(-1) === "down")).toHaveLength(parallel);
        for (const config of configs) expect(existsSync(dirname(config))).toBe(false);
        for (const call of records(fixture)) {
          for (const pid of [call.pid, call.worker]) {
            if (pid !== undefined) await waitUntil(() => !alive(pid));
          }
        }
      }
    },
    40_000,
  );

  it.each([0, 7])("preserves matrix exit %i across a failing teardown", (matrixExit) => {
    const fixture = consumer();
    const result = run(
      runtime,
      fixture,
      ["run", "--channel", "mock", "--model", "offline", "case"],
      { FAKE_FAIL_DOWN: "9", ...(matrixExit === 7 ? { FAKE_FAIL_UP: "7" } : {}) },
    );
    expect(result.status, result.stderr).toBe(matrixExit === 0 ? 9 : matrixExit);
  });

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
  const root = mkdtempSync(join(tmpdir(), "harness-built-"));
  roots.push(root);
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
    JSON.stringify({ channels: { mock: {} }, agents: { entries: { main: {} } } }),
  );
  mkdirSync(join(root, "workspace"));
  const log = join(root, "docker.jsonl");
  writeFileSync(log, "");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    FAKE_DOCKER_LOG: log,
    OPENCLAW_WORKSPACE_DIR: join(root, "workspace"),
    OPENCLAW_TEST_PROJECT_DIR: root,
    OPENCLAW_TEST_MODELS: "local/offline",
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
