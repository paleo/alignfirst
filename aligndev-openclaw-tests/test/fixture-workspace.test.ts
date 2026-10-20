import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fixturePortRange, patchDevServerRange } from "../scripts/fixture-personalization.ts";

const template = fileURLToPath(new URL("../projects-fixture/template", import.meta.url));
const devScript = "scripts/workspace/dev-server.mjs";
const workspaceScript = "scripts/workspace/workspace.mjs";
const source = readFileSync(join(template, devScript), "utf8");

interface RegistryEntry {
  status: string;
  ports?: { frontend: number };
}

test("fixture and A12 port blocks patch strictly and idempotently", () => {
  for (const [first, last] of [
    [6500, 6519],
    [6520, 6539],
    [6540, 6559],
    [6600, 6607],
  ]) {
    const patched = patchDevServerRange(source, first, last);
    assert.match(patched, new RegExp(`first: ${first},`));
    assert.match(patched, new RegExp(`last: ${last},`));
    assert.equal(patchDevServerRange(patched, first, last), patched);
    assert.deepEqual(fixturePortRange(first, last), { first, last });
  }
  for (const malformed of [
    source.replace("first: 6500", "base: 6500"),
    source.replace("last: 6519,", ""),
    source.replace('declare: ["frontend"]', 'declare: ["other"]'),
    `${source}\n    first: 6500,\n`,
  ]) {
    assert.throws(() => patchDevServerRange(malformed, 6600, 6607), /Expected exactly one/);
  }
  for (const [first, last] of [
    [0, 1],
    [1, 65536],
    [6500, 6499],
    [6500.5, 6519],
  ]) {
    assert.throws(() => fixturePortRange(first, last), /Invalid fixture port range/);
  }
});

test("fixture frozen install and real workspace/dev lifecycle", { timeout: 240_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "side-27-fixtures-"));
  const projects = [join(root, "nimbus"), join(root, "lumen")];
  const ownedWorktrees = [...projects];
  const pnpm = execFileSync("npx", ["--yes", "--package=pnpm@12.14.0", "--", "which", "pnpm"], {
    encoding: "utf8",
    timeout: 60_000,
  }).trim();
  const home = join(root, "home");
  mkdirSync(home);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    PATH: `${dirname(pnpm)}:${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  for (const key of Object.keys(env)) {
    if (/API_KEY|TOKEN|SECRET|PASSWORD/.test(key) || key.startsWith("GIT_CONFIG_KEY_"))
      delete env[key];
  }
  for (const key of ["REMOTE_DEV_DOMAIN", "REMOTE_DEV_HOST", "PORT", "GIT_CONFIG_COUNT"])
    delete env[key];
  try {
    for (const [index, repo] of projects.entries()) {
      prepareProject(repo, index === 0 ? 6500 : 6520, env);
      const lock = readFileSync(join(repo, "pnpm-lock.yaml"), "utf8");
      command(repo, pnpm, ["install", "--frozen-lockfile"], env);
      assert.equal(readFileSync(join(repo, "pnpm-lock.yaml"), "utf8"), lock);
      command(repo, process.execPath, [devScript, "status"], env);
      command(repo, process.execPath, [devScript, "down"], env);
      assert.equal(existsSync(join(repo, "local.env")), false);
      command(repo, process.execPath, [workspaceScript, "setup"], env);
      assert.equal(existsSync(join(repo, "local.env")), false);
      assert.equal(registryEntry(repo, basename(repo)).ports, undefined);
    }
    const main = projects[0];
    command(main, process.execPath, [workspaceScript, "setup", "-c", "feature"], env);
    const linked = join(root, "nimbus-feature");
    ownedWorktrees.push(linked);
    assert.equal(existsSync(join(linked, "local.env")), false);
    assert.equal(registryEntry(main, basename(linked)).ports, undefined);
    assert.equal(
      execFileSync("git", ["rev-list", "--count", "main"], {
        cwd: main,
        env,
        encoding: "utf8",
      }).trim(),
      "1",
    );

    const ports: number[] = [];
    for (const repo of [...projects, linked]) {
      command(repo, process.execPath, [devScript, "setup"], env);
      const port = readPort(repo);
      const first = repo === projects[1] ? 6520 : 6500;
      assert(port >= first && port <= first + 19);
      assert.equal(
        registryEntry(repo === linked ? main : repo, basename(repo)).ports?.frontend,
        port,
      );
      ports.push(port);
      const before = readFileSync(join(repo, "local.env"), "utf8");
      command(repo, process.execPath, [devScript, "setup"], env);
      assert.equal(readFileSync(join(repo, "local.env"), "utf8"), before);
      const output = command(repo, process.execPath, [devScript, "up"], env);
      assert.match(output, new RegExp(`http://localhost:${port}`));
      const response = await fetch(`http://127.0.0.1:${port}`);
      assert.equal(response.status, 200);
    }
    assert.equal(new Set(ports).size, 3);

    const port = readPort(linked);
    const transitions = [
      { domain: "dev.example.test", host: "192.0.2.10", url: `https://p${port}.dev.example.test` },
      { domain: "new.example.test", host: "192.0.2.10", url: `https://p${port}.new.example.test` },
      { host: "192.0.2.10", url: `http://192.0.2.10:${port}` },
      { host: "192.0.2.11", url: `http://192.0.2.11:${port}` },
      { url: `http://localhost:${port}` },
    ];
    for (const transition of transitions) {
      command(linked, process.execPath, [devScript, "down"], env);
      const next = { ...env };
      if (transition.domain !== undefined) next.REMOTE_DEV_DOMAIN = transition.domain;
      if (transition.host !== undefined) next.REMOTE_DEV_HOST = transition.host;
      const output = command(linked, process.execPath, [devScript, "up"], next);
      assert.match(output, /Dev servers started!/);
      assert(output.includes(transition.url));
      assert(
        readFileSync(join(linked, "local.env"), "utf8").includes(`PUBLIC_URL=${transition.url}\n`),
      );
      assert.equal(readPort(linked), port);
    }
    command(main, process.execPath, [workspaceScript, "remove", basename(linked)], env);
    assert.equal(existsSync(linked), false);
    const registry = JSON.parse(
      readFileSync(join(main, ".local-wt/workspace-registry/workspaces.json"), "utf8"),
    );
    assert.equal(registry.workspaces[basename(linked)], undefined);
    command(main, "git", ["branch", "-D", "feature"], env);
    for (const repo of projects) command(repo, process.execPath, [devScript, "down"], env);
    for (const port of ports) {
      await assert.rejects(fetch(`http://127.0.0.1:${port}`));
    }
  } finally {
    for (const repo of ownedWorktrees) {
      if (existsSync(join(repo, "node_modules"))) {
        command(repo, process.execPath, [devScript, "down"], env);
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

function prepareProject(repo: string, first: number, env: NodeJS.ProcessEnv): void {
  cpSync(template, repo, { recursive: true, filter: (path) => !path.includes("node_modules") });
  writeFileSync(join(repo, devScript), patchDevServerRange(source, first, first + 19));
  writeFileSync(
    join(repo, ".alignfirst.json"),
    JSON.stringify({ schemaVersion: 1, portRange: fixturePortRange(first, first + 19) }),
  );
  command(repo, "git", ["init", "-q", "-b", "main"], env);
  command(repo, "git", ["add", "-A"], env);
  command(
    repo,
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-qm",
      "fixture init",
    ],
    env,
  );
}

function command(cwd: string, executable: string, args: string[], env: NodeJS.ProcessEnv): string {
  const result = spawnSync(executable, args, { cwd, env, encoding: "utf8", timeout: 60_000 });
  assert.ifError(result.error);
  assert.equal(
    result.status,
    0,
    `${executable} ${args.join(" ")}: ${result.stdout}\n${result.stderr}`,
  );
  return result.stdout;
}

function registryEntry(repo: string, name: string): RegistryEntry {
  const registry = JSON.parse(
    readFileSync(join(repo, ".local-wt/workspace-registry/workspaces.json"), "utf8"),
  );
  return registry.workspaces[name];
}

function readPort(repo: string): number {
  const port = readFileSync(join(repo, "local.env"), "utf8").match(/^PORT=(\d+)$/m)?.[1];
  assert.notEqual(port, undefined);
  return Number(port);
}
