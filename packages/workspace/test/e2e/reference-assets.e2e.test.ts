import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

import { composeProjectName } from "../../src/helpers.js";
import { packageRoot } from "./fixture.js";

const assets = resolve(packageRoot, "../../skills/alignfirst-setup-guide/assets");
const indexUrl = pathToFileURL(join(packageRoot, "dist/index.js")).href;

interface Capture {
  command: string;
  args: string[];
  cwd: string;
  project?: string;
  retained?: string;
}

it.each(["Review-ABC", "Review-ABC-deadbeef"])(
  "selects the registered Compose project across reference lifecycles: %s",
  (name) => {
    const root = mkdtempSync(join(tmpdir(), "reference-assets-"));
    try {
      const main = join(root, "main");
      const target = join(root, "nested", "Review-ABC");
      const bin = join(root, "bin");
      for (const dir of [main, target, bin]) mkdirSync(dir, { recursive: true });
      const capture = join(root, "capture.jsonl");
      writeFileSync(
        join(target, ".env"),
        "DB_USER=test\nDB_PORT=1234\nDB_NAME=test\nAPI_URL=http://test\n",
      );
      for (const command of ["docker", "npm"]) writeFakeCommand(bin, command);
      const stub = join(root, "entry.mjs");
      writeFileSync(stub, entrySource());
      const dev = adaptDev(readFileSync(join(assets, "dev-server.mjs"), "utf8"), stub);
      writeFileSync(join(root, "dev.mjs"), dev);
      const env = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        CAPTURE: capture,
        TARGET: target,
        MAIN: main,
        REGISTERED_NAME: name,
        RETAINED: "yes",
      };
      const started = spawnSync(process.execPath, [join(root, "dev.mjs")], {
        cwd: main,
        env,
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(started.stderr).toBe("");
      expect(started.status).toBe(0);
      const project = composeProjectName(name);
      expect(started.stdout).toContain(`docker compose -p '${project}' logs -f database`);
      expect(existsSync(join(main, ".local-wt", "tunnels", name))).toBe(true);

      rmSync(target, { recursive: true });
      const workspace = readFileSync(join(assets, "workspace.mjs"), "utf8").replace(
        '"@alignfirst/workspace"',
        JSON.stringify(pathToFileURL(stub).href),
      );
      writeFileSync(join(root, "workspace.mjs"), `${workspace}\nfunction closeDevTunnel() {}\n`);
      const purged = spawnSync(process.execPath, [join(root, "workspace.mjs")], {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(purged.stderr).toBe("");
      expect(purged.status).toBe(0);
      const calls: Capture[] = readFileSync(capture, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const docker = calls.filter((call) => call.command === "docker");
      expect(docker.map((call) => call.args.slice(4))).toEqual([
        ["-d"],
        ["-T", "database", "pg_isready", "-h", "127.0.0.1", "-q"],
        ["-d"],
        ["-T", "database", "pg_isready", "-h", "127.0.0.1", "-q"],
        [],
        ["-v"],
      ]);
      expect(docker.map((call) => call.args.slice(0, 4))).toEqual([
        ["compose", "-p", project, "up"],
        ["compose", "-p", project, "exec"],
        ["compose", "-p", project, "up"],
        ["compose", "-p", project, "exec"],
        ["compose", "-p", project, "down"],
        ["compose", "-p", project, "down"],
      ]);
      expect(docker.slice(0, -1).every((call) => call.cwd === target)).toBe(true);
      expect(docker.at(-1)?.cwd).toBe(main);
      expect(existsSync(main)).toBe(true);
      expect(existsSync(target)).toBe(false);
      const indirect = calls.filter((call) => call.command === "npm");
      expect(indirect.map((call) => call.args)).toEqual([
        ["run", "migrate"],
        ["run", "seed"],
      ]);
      expect(
        indirect.every(
          (call) => call.project === project && call.cwd === target && call.retained === "yes",
        ),
      ).toBe(true);
      expect(existsSync(join(main, ".local-wt", "tunnels", name))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

function writeFakeCommand(bin: string, command: string): void {
  const path = join(bin, command);
  writeFileSync(
    path,
    `#!${process.execPath}
import { appendFileSync } from "node:fs";
appendFileSync(process.env.CAPTURE, JSON.stringify({
  command: ${JSON.stringify(command)}, args: process.argv.slice(2), cwd: process.cwd(),
  project: process.env.COMPOSE_PROJECT_NAME, retained: process.env.RETAINED,
}) + "\\n");
`,
  );
  chmodSync(path, 0o755);
}

function entrySource(): string {
  return `export { helpers } from ${JSON.stringify(indexUrl)};
const name = process.env.REGISTERED_NAME;
const currentWorktree = process.env.TARGET;
const mainWorktree = process.env.MAIN;
export async function runDevServer(config) {
  await config.setup({ name, currentWorktree, mainWorktree, ports: { frontend: 1234 } });
  const ctx = { name, cwd: currentWorktree, ports: { frontend: 1234 } };
  const callbacks = config.servers.filter((server) => server.kind === "callback");
  for (const server of callbacks) await server.start(ctx);
  console.log(config.formatSummary({ workspace: { name, worktree: currentWorktree }, servers: [] }));
  for (const server of callbacks.toReversed()) await server.stop(ctx);
}
export async function runWorkspace(config) {
  await config.purgeInfrastructure({ name, worktree: currentWorktree, mainWorktree });
}
`;
}

function adaptDev(source: string, stub: string): string {
  const withImport = source.replace(
    '"@alignfirst/workspace"',
    JSON.stringify(pathToFileURL(stub).href),
  );
  // Activate the documented callback and summary only in this disposable harness.
  const callbackStart = withImport.indexOf('    // {\n    //   kind: "callback"');
  const callbackEnd = withImport.indexOf('    {\n      kind: "spawn"', callbackStart);
  const summaryStart = withImport.indexOf("  // formatSummary:");
  const summaryEnd = withImport.indexOf("\n});", summaryStart);
  expect(callbackStart).toBeGreaterThan(0);
  expect(summaryStart).toBeGreaterThan(callbackEnd);
  return (
    withImport.slice(0, callbackStart) +
    withImport.slice(callbackStart, callbackEnd).replace(/^ {4}\/\/ ?/gm, "    ") +
    withImport.slice(callbackEnd, summaryStart) +
    withImport.slice(summaryStart, summaryEnd).replace(/^ {2}\/\/ ?/gm, "  ") +
    withImport.slice(summaryEnd) +
    '\nfunction openDevTunnel() { return "fake-tunnel"; }\nfunction closeDevTunnel() {}\n'
  );
}
