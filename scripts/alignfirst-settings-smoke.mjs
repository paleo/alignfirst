#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repository, "packages/alignfirst/bin/alignfirst.mjs");
const secret = "PRIVATE-SMOKE-SETTING-VALUE";
const artifacts = process.argv[2] === undefined ? undefined : resolve(process.argv[2]);

try {
  smoke();
} catch (error) {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
}

function smoke() {
  assert.ok(
    existsSync(join(repository, "packages/alignfirst/dist/cli.js")),
    "Build alignfirst first.",
  );
  if (artifacts !== undefined) mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(join(tmpdir(), "alignfirst-settings-smoke-"));
  const cases = [];
  try {
    const fixture = createFixture(root, cases);
    checkUnknownSettings(fixture);
    checkKnownFailures(fixture);
    checkLegacyRegistry(fixture);
    const summary = { passed: cases.length, cases };
    if (artifacts !== undefined)
      writeFileSync(join(artifacts, "summary.json"), `${JSON.stringify(summary, undefined, 2)}\n`);
    console.log(
      `PASS: ${cases.length} isolated built-CLI settings cases; no config rewrites or value leaks`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    assert.equal(existsSync(root), false);
  }
}

function createFixture(root, cases) {
  const home = join(root, "home");
  const project = join(home, "project");
  const companion = join(home, ".alignfirst/companions/app");
  for (const path of [project, companion, join(root, "tmp"), join(root, "templates")])
    mkdirSync(path, { recursive: true });
  const env = {
    HOME: home,
    PATH: process.env.PATH,
    TMPDIR: join(root, "tmp"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    LANG: "C.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(home, "empty-gitconfig"),
    GIT_TEMPLATE_DIR: join(root, "templates"),
    GIT_TERMINAL_PROMPT: "0",
  };
  const git = spawnSync("git", ["init", "--quiet", "--initial-branch=main", project], {
    env,
    encoding: "utf8",
  });
  assert.equal(git.status, 0, git.stderr);
  return {
    root,
    home,
    project,
    companion,
    env,
    config: join(project, "alignfirst.json"),
    registry: join(home, ".alignfirst/companions/registry.json"),
    cases,
  };
}

function checkUnknownSettings(f) {
  const config = {
    schemaVersion: 1,
    plans: { repositoryFolder: "work", autoArchive: true },
    git: { defaultBranch: "main", commit: { style: "conventionalCommit" } },
  };
  writeJson(f.config, config);
  writeJson(f.registry, {
    extra: secret,
    "unknown\n\u001b\u202e\u2028": secret,
    ["__proto__"]: { secret },
    root: secret,
    paths: { [secret]: { docs: true } },
    projects: {
      "~/project": {
        dir: "app",
        extra: secret,
        items: { alignfirst: "project", docs: "project", extra: secret },
        aligndev: { profile: "work", extra: secret },
      },
      [`~/${secret}`]: { aligndev: { profile: "other", extra: secret } },
    },
  });
  const result = run(f, "unknown-every-level", 0);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.config, {
    schemaVersion: 1,
    plans: { repositoryFolder: "work", autoArchive: true },
    git: { defaultBranch: "main", commit: { style: "conventionalCommit" } },
  });
  assert.deepEqual(report.aligndev, { profile: "work" });
  assert.equal(report.companion.items.docs, "project");
  assert.equal(Object.hasOwn(report.companion.items, "extra"), false);
  for (const field of [
    "projects[<entry>].extra",
    "projects[<entry>].items.extra",
    "projects[<entry>].aligndev.extra",
  ])
    assert.ok(result.stderr.includes(`setting ${field}.`), field);
  assert.match(result.stderr, /convert paths manually/);
  assert.match(result.stderr, /Use a symlink/);
  assert.ok(result.stderr.includes("\\n\\u001b\\u202e\\u2028"));
  for (const control of ["\u001b", "\u202e", "\u2028"])
    assert.equal(result.stderr.includes(control), false);
  assert.equal(result.stderr.includes("~/project"), false);

  rmSync(f.config);
  writeJson(join(f.companion, "alignfirst.jsonc"), config);
  writeJson(f.registry, { projects: { "~/project": { dir: "app" } } });
  const companion = run(f, "companion-config-family", 0);
  assert.equal(JSON.parse(companion.stdout).source, "companion");
  assert.equal(companion.stderr, "");
  writeJson(join(f.companion, "alignfirst.jsonc"), { ...config, extra: secret });
  assert.match(
    run(f, "companion-config-rejects-unknown", 1).stderr,
    /unknown property|additional properties/i,
  );
  rmSync(join(f.companion, "alignfirst.jsonc"));

  for (const [name, value] of [
    ["root", { extra: secret }],
    ["plans", { plans: { folder: "work" } }],
    ["git", { git: { extra: secret } }],
    ["commit", { git: { commit: { style: "conventionalCommit", extra: secret } } }],
  ]) {
    writeJson(f.config, { schemaVersion: 1, ...value });
    assert.match(
      run(f, `project-rejects-unknown-${name}`, 1).stderr,
      /unknown property|additional properties/i,
    );
  }
  writeJson(f.config, { schemaVersion: 1 });
  const workspace = join(f.project, "alignfirst-workspace.json");
  for (const [name, value] of [
    ["root", { extra: secret }],
    ["workspace", { workspace: { extra: secret } }],
    ["command", { workspace: { finalize: [{ name: "step", run: ["true"], extra: secret }] } }],
  ]) {
    writeJson(workspace, { schemaVersion: 1, ...value });
    assert.match(
      run(f, `workspace-rejects-unknown-${name}`, 1).stderr,
      /unknown property|additional properties/i,
    );
  }
  rmSync(workspace);
}

function checkKnownFailures(f) {
  writeJson(f.registry, { projects: {} });
  for (const [name, known, expected] of [
    ["schema", { schemaVersion: 2 }, /schemaVersion.*constant/],
    ["cli", { cli: secret }, /unknown property|additional properties/i],
    ["pattern", { ticketIdPattern: `[${secret}` }, /not a valid regular expression/],
    ["pattern-anchors", { ticketIdPattern: "^ABC$|^XYZ$" }, /one anchored expression/],
    ["plans-structure", { plans: [] }, /plans.*(object|invalid)/],
    ["archive", { plans: { autoArchive: secret } }, /autoArchive.*boolean/],
    ["port", { portRange: { first: 0, last: 100 } }, /unknown property|additional properties/i],
    ["git", { git: null }, /git.*object/],
    ["commit", { git: { commit: { style: secret } } }, /style.*constant/],
    ["required-commit", { git: { commit: {} } }, /style.*required|required.*style/],
  ]) {
    writeJson(f.config, { schemaVersion: 1, ...known });
    assert.match(run(f, `invalid-config-${name}`, 1).stderr, expected);
  }
  for (const [name, value, expected] of [
    ["root", [], /must be object/],
    ["required-schema", {}, /schemaVersion.*required|required.*schemaVersion/],
  ]) {
    writeJson(f.config, value);
    assert.match(run(f, `invalid-config-${name}`, 1).stderr, expected);
  }
  writeFileSync(f.config, `{"extra":"${secret}", BROKEN}`);
  assert.match(run(f, "invalid-config-json", 1).stderr, /valid JSON|Invalid JSON/);
  writeJson(f.config, { schemaVersion: 1 });

  for (const [name, entry, expected] of [
    ["structure", [], /must be an object/],
    ["required-entry", { extra: secret }, /define "dir" or "aligndev"/],
    ["dir", { dir: " " }, /nonblank path/],
    ["items", { dir: "app", items: [] }, /items must be an object/],
    ["item", { dir: "app", items: { docs: secret } }, /docs must be/],
    ["session-item", { dir: "app", items: { _aligndev: "project" } }, /_aligndev must be/],
    ["items-dir", { items: {}, aligndev: { profile: "work" } }, /define "dir" when "items"/],
    ["profile-structure", { aligndev: [] }, /aligndev must be an object/],
    ["profile-required", { aligndev: { extra: secret } }, /profile must be/],
    ["profile-value", { aligndev: { profile: 42 } }, /profile must be/],
    ["profile-blank", { aligndev: { profile: " " } }, /nonblank profile name/],
    ["session-semantic", { dir: "app", items: { _aligndev: "companion" } }, /requires/],
  ]) {
    writeJson(f.registry, { extra: secret, projects: { "~/project": entry } });
    assert.match(run(f, `invalid-registry-${name}`, 1).stderr, expected);
  }
  writeJson(f.registry, { projects: { "invalid-relative-project": { dir: "app" } } });
  assert.match(run(f, "invalid-registry-project-key", 1).stderr, /projects key must be/);
  writeJson(f.registry, { projects: [] });
  assert.match(
    run(f, "invalid-registry-projects-structure", 1).stderr,
    /projects must be an object/,
  );
  writeFileSync(f.registry, `{"extra":"${secret}", BROKEN}`);
  assert.match(run(f, "invalid-registry-json", 1).stderr, /must contain valid JSON/);
}

function checkLegacyRegistry(f) {
  writeJson(f.registry, { paths: { "~/project": { docs: true } } });
  const missingProjects = run(f, "legacy-only-registry", 1);
  assert.match(missingProjects.stderr, /convert paths manually/);
  assert.match(missingProjects.stderr, /projects must be an object/);
  writeJson(f.registry, { paths: { "~/project": { docs: true } }, projects: {} });
  const ignored = run(f, "legacy-registry-ignored", 0);
  assert.equal(JSON.parse(ignored.stdout).companion, null);
  assert.equal(JSON.parse(ignored.stdout).locations.docs.in, "project");
  writeJson(f.registry, { projects: { "~/project": { dir: "app", items: { docs: "project" } } } });
  const clean = run(f, "known-settings-no-warning", 0);
  assert.equal(clean.stderr, "");
}

function run(f, name, status) {
  const before = snapshot(f.root);
  const result = spawnSync(process.execPath, [cli, "config", "--json"], {
    cwd: f.project,
    env: f.env,
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 1024 * 1024,
  });
  if (artifacts !== undefined) {
    writeFileSync(join(artifacts, `${name}.stdout`), result.stdout ?? "");
    writeFileSync(join(artifacts, `${name}.stderr`), result.stderr ?? "");
  }
  assert.equal(result.error, undefined, name);
  assert.equal(result.status, status, `${name}: ${result.stderr}`);
  assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false, `${name}: value leak`);
  assert.deepEqual(snapshot(f.root), before, `${name}: a read changed fixture files`);
  if (status === 0) JSON.parse(result.stdout);
  else assert.equal(result.stdout, "", `${name}: failure polluted stdout`);
  f.cases.push({ name, status: result.status });
  return result;
}

function snapshot(path) {
  return Object.fromEntries(
    readdirSync(path, { withFileTypes: true }).map((entry) => {
      const child = join(path, entry.name);
      return [entry.name, entry.isDirectory() ? snapshot(child) : readFileSync(child, "utf8")];
    }),
  );
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, undefined, 2)}\n`);
}
