import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterEach, expect, vi } from "vitest";
import { fixtureEnvironment } from "./environment.js";

export const RUN_CASE = ["run", "--channel", "mock", "--model", "offline", "case"];

const packageRoot = resolve(import.meta.dirname, "..");
const cli = join(packageRoot, "bin", "cli.mjs");
const fakeDocker = readFileSync(join(packageRoot, "test", "fixtures", "fake-docker.mjs"), "utf8");
const roots: string[] = [];
const children: ChildProcess[] = [];

export interface Consumer {
  root: string;
  log: string;
  env: NodeJS.ProcessEnv;
}

export interface DockerRecord {
  unexpected?: string[];
  args?: string[];
  pid?: number;
  worker?: number;
  config?: string;
  workspace?: string;
  uid?: string;
}

export interface StartedCli {
  child: ChildProcess;
  output(): string;
  closed: Promise<void>;
}

/** Registers the timeout and the teardown shared by the built-CLI suites. */
export function useBuiltCliFixtures(): void {
  // Each lifecycle case starts several real CLIs, beyond the unit-test 5s default.
  vi.setConfig({ testTimeout: 30_000 });
  afterEach(cleanUpFixtures);
}

async function cleanUpFixtures(): Promise<void> {
  const unexpectedCommands: string[][] = [];
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
      if (record.unexpected !== undefined) unexpectedCommands.push(record.unexpected);
      for (const pid of [record.pid, record.worker]) {
        if (pid === undefined) continue;
        if (alive(pid)) process.kill(pid, "SIGKILL");
        await waitUntil(() => !alive(pid));
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
  expect(unexpectedCommands, "Unexpected fake Docker commands").toEqual([]);
}

export function consumer(): Consumer {
  const sandbox = mkdtempSync(join(tmpdir(), "harness-built-"));
  roots.push(sandbox);
  const root = join(sandbox, "project");
  const home = join(sandbox, "home");
  mkdirSync(root);
  mkdirSync(home, { mode: 0o700 });
  const bin = join(root, "bin");
  mkdirSync(bin);
  const docker = join(bin, "docker");
  writeFileSync(docker, `#!${process.execPath}\n${fakeDocker}`);
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
  return { root, log, env: consumerEnvironment({ root, home, bin, log }) };
}

function consumerEnvironment(paths: {
  root: string;
  home: string;
  bin: string;
  log: string;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...fixtureEnvironment(),
    HOME: paths.home,
    XDG_STATE_HOME: join(paths.home, "state"),
    PATH: `${paths.bin}${delimiter}${process.env.PATH}`,
    // The fake Docker is a Node script started on every Docker call: keep preloads out of it.
    NODE_OPTIONS: "",
    FAKE_DOCKER_LOG: paths.log,
    OPENCLAW_WORKSPACE_DIR: join(paths.root, "workspace"),
    OPENCLAW_TEST_PROJECT_DIR: paths.root,
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
  return env;
}

export function run(fixture: Consumer, args: string[], extra: Record<string, string> = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: fixture.root,
    env: { ...fixture.env, ...extra },
    encoding: "utf8",
    timeout: 25_000,
  });
}

export function start(
  fixture: Consumer,
  args: string[],
  extra: Record<string, string>,
): StartedCli {
  const child = spawn(process.execPath, [cli, ...args], {
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

export async function waitForOwnedProcesses(fixture: Consumer): Promise<void> {
  for (const call of records(fixture)) {
    for (const pid of [call.pid, call.worker]) {
      if (pid !== undefined) await waitUntil(() => !alive(pid));
    }
  }
}

export function downCalls(fixture: Consumer): DockerRecord[] {
  return records(fixture).filter((call) => call.args?.at(-1) === "down");
}

export function lastConfigPath(fixture: Consumer): string {
  const path = configPaths(fixture).at(-1);
  if (path === undefined) throw new Error("Missing rendered config in Docker calls");
  return path;
}

export function configPaths(fixture: Consumer): string[] {
  return [
    ...new Set(
      records(fixture)
        .filter((call) => call.args?.includes("up"))
        .map((call) => call.config)
        .filter((path): path is string => path !== undefined),
    ),
  ];
}

export function records(fixture: Pick<Consumer, "log">): DockerRecord[] {
  return readFileSync(fixture.log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export async function waitUntil(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for owned child");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
