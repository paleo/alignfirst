#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const repository = resolve(dirname(script), "..");
const nativeKinds = ["claude", "pi", "codex"];
const outputLimit = 128 * 1024;

try {
  const kind = basename(process.argv[1]);
  if (nativeKinds.includes(kind)) await nativeFixture(kind);
  else await smoke();
} catch (error) {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
}

async function smoke() {
  assert.notEqual(process.platform, "win32", "This smoke requires POSIX executable symlinks.");
  for (const name of ["alignfirst", "aligndev"]) {
    assert.ok(
      existsSync(join(repository, "packages", name, "dist", "cli.js")),
      `Build ${name} first: fnm exec --using=.nvmrc npm run build`,
    );
  }
  const root = mkdtempSync(join(tmpdir(), "coding-profiles-smoke-"));
  let fixture;
  try {
    fixture = createFixture(root);
    await createProjects(fixture);
    const failures = [];
    for (const check of [
      settingsChecks,
      profileOnlyChecks,
      companionChecks,
      resumeChecks,
      quotaChecks,
      automaticChecks,
    ])
      await checkCase(check.name, () => check(fixture), failures);
    assert.equal(failures.length, 0, `${failures.length} integration section(s) failed.`);
    console.log("PASS: real CLI reports, profiles, worktrees, resume identity, and isolated quota");
  } finally {
    try {
      if (fixture !== undefined) await cleanNativeProcesses(fixture);
    } finally {
      rmSync(root, { recursive: true, force: true });
      assert.equal(existsSync(root), false, "Disposable fixture must be removed.");
    }
  }
}

async function checkCase(label, check, failures) {
  try {
    await check();
  } catch (error) {
    failures.push(error);
    console.error(`FAIL ${label}: ${String(error.stack ?? error).slice(-6000)}`);
  }
}

function createFixture(root) {
  const home = join(root, "home");
  const bin = join(root, "bin");
  const stores = Object.fromEntries(
    ["a", "b", "unavailable", "replacement", "pi", "quota", "inherited-codex"].map((name) => [
      name,
      join(home, "native", name),
    ]),
  );
  for (const path of [
    home,
    bin,
    join(root, "tmp"),
    join(root, "templates"),
    ...Object.values(stores),
  ])
    mkdirSync(path, { recursive: true });
  symlinkSync(process.execPath, join(bin, "node"));
  const git = process.env.PATH.split(":")
    .map((path) => join(path, "git"))
    .find((path) => existsSync(path));
  assert.ok(git, "Git must be installed.");
  symlinkSync(realpathSync(git), join(bin, "git"));
  for (const name of ["alignfirst", "aligndev"])
    symlinkSync(join(repository, "packages", name, "bin", `${name}.mjs`), join(bin, name));
  for (const name of nativeKinds) symlinkSync(script, join(bin, name));
  const env = {
    HOME: home,
    PATH: bin,
    TMPDIR: join(root, "tmp"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    LANG: "C.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(home, "empty-gitconfig"),
    GIT_TEMPLATE_DIR: join(root, "templates"),
    GIT_TERMINAL_PROMPT: "0",
    SMOKE_ROOT: root,
    CODEX_HOME: stores["inherited-codex"],
    PI_CODING_AGENT_DIR: join(home, "inherited-pi"),
    CLAUDECODE: "1",
    CLAUDE_CODE_SESSION_ID: "synthetic-parent",
    CODEX_THREAD_ID: "synthetic-parent",
    PI_CODING_AGENT: "true",
    AI_AGENT: "pi",
    SMOKE_REMOVE: "synthetic-remove-value",
  };
  writeFileSync(env.GIT_CONFIG_GLOBAL, "");
  const project = join(home, "app");
  const linked = join(home, "linked");
  const companionProject = join(home, "companion-app");
  const registry = join(home, ".alignfirst", "companions", "registry.json");
  const companion = join(dirname(registry), "app-companion");
  const entries = {
    "~/app": { aligndev: { profile: "a" } },
    "~/companion-app": { dir: "app-companion", aligndev: { profile: "b" } },
  };
  const profiles = {
    a: {
      agent: "claude",
      configDir: stores.a,
      defaultModel: "choice",
      modelAliases: { choice: "opus" },
      unset: ["SMOKE_REMOVE"],
    },
    b: {
      agent: "claude",
      configDir: stores.b,
      defaultModel: "sonnet",
      modelAliases: { choice: "haiku" },
      unset: ["SMOKE_REMOVE"],
    },
    "same-account": {
      agent: "claude",
      configDir: stores.a,
      defaultModel: "sonnet",
      modelAliases: { choice: "haiku" },
      unset: ["SMOKE_REMOVE"],
    },
    unavailable: {
      agent: "claude",
      configDir: stores.unavailable,
      modelAliases: { choice: "opus" },
    },
    replacement: {
      agent: "claude",
      configDir: stores.replacement,
      modelAliases: { choice: "opus" },
    },
    pi: {
      agent: "pi",
      configDir: stores.pi,
      defaultModel: "choice",
      modelAliases: { choice: "fixture/exact-model" },
      env: { SMOKE_CODING_ONLY: "coding-value", SMOKE_SCOPE: "coding-scope" },
      unset: ["SMOKE_REMOVE"],
      quota: {
        source: "codex",
        configDir: stores.quota,
        env: { SMOKE_QUOTA_ONLY: "quota-value", SMOKE_SCOPE: "quota-scope" },
        unset: ["PI_CODING_AGENT_DIR", "SMOKE_REMOVE"],
      },
    },
  };
  writeJson(join(home, ".alignfirst", "aligndev.settings.json"), {
    code: { profile: "b", profiles },
  });
  writeJson(registry, { projects: entries });
  return {
    root,
    home,
    bin,
    env,
    stores,
    project,
    linked,
    companionProject,
    companion,
    registry,
    entries,
  };
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function createProjects(f) {
  for (const project of [f.project, f.companionProject]) {
    mkdirSync(project);
    await command(f, project, "git", ["init", "--quiet"]);
    writeFileSync(join(project, "README.md"), "Disposable CLI smoke project.\n");
    await command(f, project, "git", ["add", "README.md"]);
    await command(f, project, "git", [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgSign=false",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ]);
  }
  await command(f, f.project, "git", ["worktree", "add", "--quiet", "-b", "linked", f.linked]);
  mkdirSync(join(f.project, ".plans"));
  mkdirSync(join(f.linked, ".plans"));
}

async function command(f, cwd, executable, args, expected = 0) {
  const result = await run(join(f.bin, executable), args, cwd, f.env);
  assert.equal(
    result.code,
    expected,
    `${executable} ${args.join(" ")}\n${result.stdout.slice(-6000)}\n${result.stderr.slice(-6000)}`,
  );
  for (const value of ["synthetic-remove-value", "coding-value", "quota-value"]) {
    assert.equal(
      `${result.stdout}${result.stderr}`.includes(value),
      false,
      "CLI must not print environment values.",
    );
  }
  return result;
}

function run(executable, args, cwd, env) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let failure;
    let escalation;
    const terminate = (reason) => {
      if (failure !== undefined) return;
      failure = new Error(reason);
      child.kill("SIGTERM");
      escalation = setTimeout(() => child.kill("SIGKILL"), 3000);
    };
    const timeout = setTimeout(() => terminate("CLI exceeded 20-second smoke bound."), 20_000);
    const collect = (chunk, stream) => {
      if (failure !== undefined) return;
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + chunk.length > outputLimit) {
        terminate("CLI exceeded 128-KiB output bound.");
        return;
      }
      if (stream === "stdout") stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.on("data", (chunk) => collect(chunk, "stdout"));
    child.stderr.on("data", (chunk) => collect(chunk, "stderr"));
    child.on("error", (error) => {
      failure = error;
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      clearTimeout(escalation);
      if (failure !== undefined) reject(failure);
      else resolveResult({ code, signal, stdout, stderr });
    });
  });
}

async function settingsChecks(f) {
  const path = join(f.home, ".alignfirst/aligndev.settings.json");
  const original = readFileSync(path);
  const inventoryRoot = join(f.home, "settings-inventory");
  writeJson(join(inventoryRoot, ".alignfirst-projects.json"), {});
  const stale = JSON.parse(original);
  stale.unknownRoot = "private-stale-value";
  stale.code.unknownCode = "private-stale-value";
  stale.code.agent = "pi";
  stale.code.defaultProfiles = { claude: "missing" };
  stale.code.profiles.a.unknownProfile = "private-stale-value";
  stale.code.profiles.a.quota = { source: "none", unknownQuota: "private-stale-value" };
  try {
    writeJson(path, stale);
    const before = readFileSync(path);
    await readOnly(f, async () => {
      for (const args of [
        ["code", "--help"],
        ["guide", "code"],
        ["project", "list", "--json", "--root", inventoryRoot],
      ]) {
        const result = await command(f, f.project, "aligndev", args);
        assert.match(result.stderr, /unknownRoot/);
        assert.match(result.stderr, /code.unknownCode/);
        assert(result.stderr.includes("code.profiles[<entry>].unknownProfile"));
        assert(result.stderr.includes("code.profiles[<entry>].quota.unknownQuota"));
        assert.match(result.stderr, /code.agent.*manual conversion/);
        assert.match(result.stderr, /code.defaultProfiles is retired.*manually/);
        assert.equal(result.stdout.includes("Warning:"), false);
        assert.equal(result.stderr.includes("private-stale-value"), false);
        if (args.includes("--json")) JSON.parse(result.stdout);
        else assert(result.stdout.includes("a"));
      }
    });
    const started = await launch(f, f.project, ["new", "-m", "stale settings fixture"]);
    await metadata(f, f.project, started.file, {
      profile: "a",
      agent: "claude",
      status: "succeeded",
    });
    assert.equal(lastEvent(f).store, f.stores.a);
    assert.deepEqual(readFileSync(path), before);
    stale.code.profiles.a.default = "invalid-known-value";
    writeJson(path, stale);
    const invalidBefore = readFileSync(path);
    const eventCount = events(f).length;
    await readOnly(f, async () => {
      for (const args of [
        ["code", "--help"],
        ["guide", "code"],
        ["project", "list", "--json", "--root", inventoryRoot],
        ["code", "new", "-m", "invalid known field"],
      ]) {
        const result = await command(f, f.project, "aligndev", args, 1);
        assert.match(result.stderr, /default must be a boolean/);
        assert.equal(result.stdout, "");
        assert.equal(result.stderr.includes("invalid-known-value"), false);
        assert.equal(result.stderr.includes("private-stale-value"), false);
      }
    });
    assert.equal(events(f).length, eventCount);
    assert.deepEqual(readFileSync(path), invalidBefore);
  } finally {
    writeFileSync(path, original);
  }
  console.log(
    "PASS: stale settings warn on stderr, launch succeeds, JSON stays clean, invalid known values fail, input unchanged",
  );
}

async function profileOnlyChecks(f) {
  await readOnly(f, async () => {
    for (const cwd of [f.project, f.linked]) {
      const report = await reportAt(f, cwd);
      assert.deepEqual(report.aligndev, { profile: "a" });
      assert.equal(report.companion, null);
      for (const [item, location] of Object.entries(report.locations)) {
        assert.equal(location.in, "project");
        assert.equal(location.path, join(cwd, item === "_aligndev" ? ".plans" : item));
      }
      const text = await command(f, cwd, "alignfirst", ["config"]);
      assert.match(text.stdout, /AlignDev profile: a/);
      assert.match(text.stdout, /Companion: none/);
      await selectionHelp(f, cwd, "a");
    }
    await selectionHelp(f, f.linked, "b", true);
  });
  const linked = await launch(f, f.linked, ["new", "-m", "linked fixture"]);
  await metadata(f, f.linked, linked.file, {
    profile: "a",
    agent: "claude",
    model: "choice",
    status: "succeeded",
  });
  assert.equal(lastEvent(f).store, f.stores.a);
  assert.equal(lastEvent(f).cwd, f.linked);
  assert.equal(lastEvent(f).args.includes("opus"), true);
  const override = await launch(f, f.project, ["new", "--profile", "b", "-m", "override fixture"]);
  await metadata(f, f.project, override.file, {
    profile: "b",
    model: "sonnet",
    status: "succeeded",
  });
  assert.equal(lastEvent(f).store, f.stores.b);
  console.log(
    "PASS: profile-only placement, linked-worktree selection, explicit override, help/guide",
  );
}

async function readOnly(f, action) {
  const before = snapshot(f.root);
  await action();
  assert.deepEqual(
    snapshot(f.root),
    before,
    "Report/help/guide reads must not mutate the fixture.",
  );
}

function snapshot(root) {
  const entries = [];
  const visit = (path) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) entries.push([path, "link", readlinkSync(path)]);
    else if (stat.isDirectory()) {
      entries.push([path, "dir", stat.mode]);
      for (const name of readdirSync(path).sort()) visit(join(path, name));
    } else
      entries.push([
        path,
        stat.mode,
        createHash("sha256").update(readFileSync(path)).digest("hex"),
      ]);
  };
  visit(root);
  return entries;
}

async function reportAt(f, cwd) {
  const result = await command(f, cwd, "alignfirst", ["config", "--json"]);
  return JSON.parse(result.stdout);
}

async function selectionHelp(f, cwd, profile, explicit = false) {
  const override = explicit ? ["--profile", profile] : [];
  for (const topic of [[], ["new"], ["resume"], ["quota"]]) {
    const help = await command(f, cwd, "aligndev", ["code", ...topic, "--help", ...override]);
    assert.ok(
      help.stdout.includes(`Effective profile: ${profile}`),
      "Help must show selected profile.",
    );
    assert.match(help.stdout, /--profile/);
  }
  const guide = await command(f, cwd, "aligndev", ["guide", "code", ...override]);
  assert.ok(guide.stdout.includes(`Effective profile: \`${profile}\``));
  assert.ok(
    guide.stdout.includes(f.stores[profile]),
    "Guide must identify selected native context.",
  );
  assert.ok(guide.stdout.includes(profile === "a" ? "choice" : "sonnet"));
}

async function launch(f, cwd, args, expected = 0) {
  const result = await command(f, cwd, "aligndev", ["code", ...args, "--quiet"], expected);
  const match = /^Session file: (.+)$/m.exec(result.stdout);
  assert.ok(
    match,
    `Every started run must expose its durable file.\n${result.stdout}\n${result.stderr}`,
  );
  return { ...result, file: resolve(cwd, match[1]) };
}

async function metadata(f, cwd, file, expected) {
  assert.ok(file.startsWith(`${f.root}/`));
  const result = await command(f, cwd, "aligndev", ["code", "status", file, "--result"]);
  const content = readFileSync(file, "utf8");
  const header = content.split("\n---\n")[0];
  for (const [key, value] of Object.entries(expected)) {
    assert.ok(result.stdout.includes(`${key}: ${value}\n`), `Status must contain ${key}: ${value}`);
    assert.ok(
      header.split("\n").includes(`${key}: ${value}`),
      `Run header must contain ${key}: ${value}`,
    );
  }
  assert.equal(content.includes("synthetic-remove-value"), false);
  assert.equal(content.includes("coding-value"), false);
  assert.equal(content.includes("quota-value"), false);
  return result.stdout;
}

function events(f) {
  const path = join(f.root, "events.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map(JSON.parse) : [];
}

function lastEvent(f) {
  return events(f).at(-1);
}

async function companionChecks(f) {
  await readOnly(f, async () => {
    const report = await reportAt(f, f.companionProject);
    assert.deepEqual(report.aligndev, { profile: "b" });
    assert.equal(report.companion.dir, f.companion);
    assert.equal(report.companion.exists, false);
    for (const [item, location] of Object.entries(report.locations)) {
      assert.equal(location.in, "companion");
      assert.equal(location.path, join(f.companion, item === "_aligndev" ? ".plans" : item));
    }
    await selectionHelp(f, f.companionProject, "b");
  });
  assert.equal(existsSync(f.companion), false, "Reading a missing companion must not create it.");
  mkdirSync(join(f.companion, ".plans"), { recursive: true });
  const run = await launch(f, f.companionProject, ["new", "-m", "companion fixture"]);
  assert.equal(dirname(run.file), join(f.companion, ".plans", "_aligndev"));
  assert.equal(existsSync(join(f.companionProject, ".plans")), false);
  await metadata(f, f.companionProject, run.file, {
    profile: "b",
    agent: "claude",
    status: "succeeded",
  });
  assert.ok(lastEvent(f).args.includes("--add-dir"));
  assert.ok(lastEvent(f).args.includes(f.companion));
  console.log("PASS: companion-backed profile and normal companion session placement");
}

async function automaticChecks(f) {
  const path = join(f.home, ".alignfirst/aligndev.settings.json");
  const originalSettings = readFileSync(path, "utf8");
  const originalRegistry = readFileSync(f.registry, "utf8");
  const originalEnv = f.env;
  const profiles = JSON.parse(originalSettings).code.profiles;
  try {
    writeJson(f.registry, { projects: {} });
    f.env = { ...originalEnv };
    for (const marker of [
      "CLAUDECODE",
      "CLAUDE_CODE_SESSION_ID",
      "CODEX_THREAD_ID",
      "PI_CODING_AGENT",
      "AI_AGENT",
    ])
      delete f.env[marker];
    writeJson(path, { code: { profiles: { pi: profiles.pi } } });
    const pi = await launch(f, f.project, ["new", "-m", "no-parent singleton"]);
    await metadata(f, f.project, pi.file, { profile: "pi", agent: "pi", status: "succeeded" });
    f.env.CLAUDECODE = "1";
    f.env.CLAUDE_CONFIG_DIR = f.stores.a;
    for (const field of ["blank", "missing"]) {
      writeJson(path, { code: { profiles: { a: { agent: "claude", configDir: f.stores.a } } } });
      const initial = await launch(f, f.project, ["new", "-m", "matching singleton"]);
      const id = lastEvent(f).id;
      await metadata(f, f.project, initial.file, {
        profile: "a",
        agent: "claude",
        status: "succeeded",
      });
      const historical = readFileSync(initial.file, "utf8").replace(
        /^profile: a\n/m,
        field === "blank" ? "profile: \n" : "",
      );
      writeFileSync(initial.file, historical);
      writeJson(path, {
        code: {
          profiles: {
            preferred: { ...profiles.b, default: true },
            other: { agent: "claude", configDir: f.stores.b },
          },
        },
      });
      const resumed = await launch(f, f.project, ["resume", id, "-m", "legacy built-ins"]);
      await metadata(f, f.project, resumed.file, {
        profile: "",
        model: "",
        agent: "claude",
        status: "succeeded",
      });
      assert.equal(lastEvent(f).store, f.stores.a);
      assert.equal(lastEvent(f).removed, "synthetic-remove-value");
      assert.equal(readFileSync(initial.file, "utf8"), historical);
      delete f.env.CLAUDECODE;
      const failed = await command(
        f,
        f.project,
        "aligndev",
        ["code", "resume", id, "-m", "no parent"],
        1,
      );
      assert.match(failed.stderr, /no coding agent/);
      f.env.CLAUDECODE = "1";
      const inferred = await launch(f, f.project, ["new", "-m", "preferred profile"]);
      await metadata(f, f.project, inferred.file, {
        profile: "preferred",
        model: "sonnet",
        status: "succeeded",
      });
      assert.equal(lastEvent(f).store, f.stores.b);
    }
  } finally {
    f.env = originalEnv;
    writeFileSync(path, originalSettings);
    writeFileSync(f.registry, originalRegistry);
  }
  console.log("PASS: automatic singleton/preferred launches and protected historical-null resume");
}

async function resumeChecks(f) {
  const first = await launch(f, f.project, ["new", "-m", "resume fixture"]);
  const id = lastEvent(f).id;
  const original = readFileSync(first.file, "utf8");
  f.entries["~/app"].aligndev.profile = "same-account";
  writeJson(f.registry, { projects: f.entries });
  const resumed = await launch(f, f.project, ["resume", id, "-m", "same native fixture identity"]);
  await metadata(f, f.project, resumed.file, {
    profile: "same-account",
    model: "choice",
    sessionId: id,
    status: "succeeded",
  });
  assert.equal(lastEvent(f).store, f.stores.a);
  assert.ok(
    lastEvent(f).args.includes("haiku"),
    "Retained alias must use current profile mapping.",
  );
  assert.equal(
    readFileSync(first.file, "utf8"),
    original,
    "Resume must not rewrite previous runs.",
  );
  const failures = [];
  for (const profile of ["unavailable", "replacement"]) {
    await checkCase(
      profile,
      async () => {
        if (profile === "replacement")
          writeFileSync(join(f.stores.replacement, "identity"), "replacement-id");
        f.entries["~/app"].aligndev.profile = profile;
        writeJson(f.registry, { projects: f.entries });
        const before = events(f).length;
        const failed = await launch(
          f,
          f.project,
          ["resume", id, "-m", "unavailable fixture identity"],
          1,
        );
        assert.equal(
          events(f).length,
          before + 1,
          "Failure must not retry/fall back to another account.",
        );
        assert.equal(lastEvent(f).store, f.stores[profile]);
        assert.ok(failed.stderr.includes(`profile "${profile}"`));
        assert.ok(failed.stderr.includes(f.stores[profile]));
        assert.match(failed.stderr, /No account fallback/);
        assert.equal(lastEvent(f).args[lastEvent(f).args.indexOf("--resume") + 1], id);
        if (profile === "replacement")
          assert.match(readFileSync(failed.file, "utf8"), /identity changed/);
        await metadata(f, f.project, failed.file, {
          profile,
          model: "choice",
          status: "failed",
          sessionId: id,
        });
        assert.equal(existsSync(join(f.stores.unavailable, "identity")), false);
      },
      failures,
    );
  }
  f.entries["~/app"].aligndev.profile = "a";
  writeJson(f.registry, { projects: f.entries });
  assert.equal(
    readFileSync(first.file, "utf8"),
    original,
    "Failed resumes must preserve prior runs.",
  );
  assert.equal(failures.length, 0, `${failures.length} resume identity assertion(s) failed.`);
  console.log(
    "PASS: project-selected resume, retained alias/native ID, missing/replacement account failures",
  );
}

async function quotaChecks(f) {
  const coding = await launch(f, f.project, ["new", "--profile", "pi", "-m", "Pi fixture"]);
  await metadata(f, f.project, coding.file, {
    profile: "pi",
    agent: "pi",
    model: "choice",
    sessionId: "pi-fixture-id",
    status: "succeeded",
  });
  assertCodingEnvironment(f, lastEvent(f));
  const outside = join(f.home, "outside-git");
  mkdirSync(outside);
  const before = events(f).length;
  const quota = await command(f, outside, "aligndev", ["code", "quota", "--profile", "pi"]);
  assert.equal(events(f).length, before + 1);
  const observed = lastEvent(f);
  assert.equal(observed.kind, "codex");
  assert.deepEqual(observed.args, ["app-server"]);
  assert.equal(observed.store, f.stores.quota);
  assert.equal(observed.piDir, undefined);
  assert.equal(observed.codingOnly, undefined);
  assert.equal(observed.quotaOnly, "quota-value");
  assert.equal(observed.scope, "quota-scope");
  assert.equal(observed.removed, undefined);
  assert.deepEqual(observed.parents, []);
  assert.match(quota.stdout, /pi/);
  assert.match(quota.stdout, /codex/i);
  assert.match(quota.stdout, /25% used/);
  assert.match(quota.stdout, /60% used/);
  assert.match(quota.stdout, /not verified/i);
  assert.equal(
    quota.stdout.includes("99%"),
    false,
    "Named Codex bucket must beat the legacy bucket.",
  );
  assert.deepEqual(
    readdirSync(outside),
    [],
    "Quota outside Git must not create project/session files.",
  );
  const after = await launch(f, f.project, ["new", "--profile", "pi", "-m", "Pi after quota"]);
  await metadata(f, f.project, after.file, { profile: "pi", agent: "pi", status: "succeeded" });
  assertCodingEnvironment(f, lastEvent(f));
  console.log("PASS: explicit Pi coding store versus independent Codex quota store, outside Git");
}

function assertCodingEnvironment(f, observed) {
  assert.equal(observed.kind, "pi");
  assert.equal(observed.store, f.stores.pi);
  assert.equal(observed.codingOnly, "coding-value");
  assert.equal(observed.scope, "coding-scope");
  assert.equal(observed.quotaOnly, undefined);
  assert.equal(observed.removed, undefined);
  assert.deepEqual(observed.parents, []);
  assert.ok(observed.args.includes("fixture/exact-model"));
}

async function cleanNativeProcesses(f) {
  const pids = events(f).map((event) => event.pid);
  const live = pids.filter(isAlive);
  for (const pid of live) process.kill(pid, "SIGKILL");
  for (let attempt = 0; attempt < 100 && pids.some(isAlive); ++attempt)
    await new Promise((done) => setTimeout(done, 20));
  assert.deepEqual(pids.filter(isAlive), [], "Every native fixture process must be reaped.");
  assert.deepEqual(live, [], "CLI returned while a native fixture process was still alive.");
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

async function nativeFixture(kind) {
  const root = process.env.SMOKE_ROOT;
  assert.ok(
    root?.includes("coding-profiles-smoke-"),
    "Native fixtures require the disposable smoke root.",
  );
  const args = process.argv.slice(2);
  const variable = { claude: "CLAUDE_CONFIG_DIR", pi: "PI_CODING_AGENT_DIR", codex: "CODEX_HOME" }[
    kind
  ];
  const store = process.env[variable];
  assert.ok(store?.startsWith(`${root}/`), "Native fixture may access only disposable storage.");
  const identity = join(store, "identity");
  const resumeAt = args.indexOf(kind === "pi" ? "--session" : "--resume");
  const id =
    resumeAt >= 0
      ? existsSync(identity)
        ? readFileSync(identity, "utf8")
        : undefined
      : kind === "pi"
        ? "pi-fixture-id"
        : "claude-fixture-id";
  appendFileSync(
    join(root, "events.jsonl"),
    `${JSON.stringify({
      kind,
      pid: process.pid,
      args,
      cwd: process.cwd(),
      store,
      id,
      piDir: process.env.PI_CODING_AGENT_DIR,
      codingOnly: process.env.SMOKE_CODING_ONLY,
      quotaOnly: process.env.SMOKE_QUOTA_ONLY,
      scope: process.env.SMOKE_SCOPE,
      removed: process.env.SMOKE_REMOVE,
      parents: [
        "CLAUDECODE",
        "CLAUDE_CODE_SESSION_ID",
        "CODEX_THREAD_ID",
        "PI_CODING_AGENT",
        "AI_AGENT",
      ].filter((name) => process.env[name] !== undefined),
    })}\n`,
  );
  if (kind === "codex") {
    assert.deepEqual(args, ["app-server"]);
    const lines = createInterface({ input: process.stdin });
    for await (const line of lines) {
      const request = JSON.parse(line);
      if (request.method === "initialize") emit({ id: 0, result: {} });
      else if (request.method === "initialized") assert.equal(request.id, undefined);
      else {
        assert.equal(request.method, "account/rateLimits/read");
        emit({
          id: 1,
          result: {
            rateLimits: { limitId: "codex", primary: { usedPercent: 99 } },
            rateLimitsByLimitId: {
              codex: {
                limitId: "codex",
                primary: { usedPercent: 60, windowDurationMins: 10080 },
                secondary: { usedPercent: 25, windowDurationMins: 300 },
              },
            },
          },
        });
      }
    }
    return;
  }
  let prompt = "";
  for await (const chunk of process.stdin) prompt += chunk;
  assert.ok(prompt.trim().length > 0, "Coding prompt must arrive on stdin.");
  if (id === undefined) {
    console.error("Conversation unavailable in selected fixture store.");
    process.exitCode = 1;
    return;
  }
  if (resumeAt < 0) writeFileSync(identity, id);
  if (kind === "claude") {
    emit({ type: "system", subtype: "init", session_id: id });
    emit({ type: "result", session_id: id, result: "fixture complete", is_error: false });
    return;
  }
  assert.deepEqual(args.slice(0, 2), ["--mode", "json"]);
  emit({
    type: "session",
    version: 3,
    id,
    cwd: process.cwd(),
    timestamp: new Date().toISOString(),
  });
  emit({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "fixture complete" }],
      stopReason: "stop",
      usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 },
    },
  });
  emit({ type: "agent_settled", aborted: false });
}

function emit(value) {
  console.log(JSON.stringify(value));
}
