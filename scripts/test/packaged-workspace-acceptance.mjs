import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export function verifyPackagedWorkspaces(options) {
  const python = spawnSync("python3", ["--version"], { env: options.env, encoding: "utf8" });
  assert.equal(python.error, undefined, "python3 is required; Python acceptance is incomplete");
  assert.equal(python.status, 0, "python3 is required; Python acceptance is incomplete");
  console.log(`Python prerequisite: ${python.stdout.trim()}`);
  const run = cliRunner(options);
  verifyDefaults(options, run);
  verifyPythonMonorepo(options, run);
  verifyCompanion(options);
  console.log(
    "PASS packed default lifecycle and package-free Python monorepo: real venv/imports/API/worker, identity/cwd/env/ports, isolation, transform preservation and owned-process cleanup",
  );
}

function cliRunner({ executable, entry, env, evidence }) {
  return (cwd, args, json = false, expectedStatus = 0) => {
    const result = spawnSync(executable, [entry, ...args], {
      cwd,
      env,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (evidence !== undefined)
      appendFileSync(
        evidence,
        `${JSON.stringify({ cwd, executable, entry, args, status: result.status, stdout: result.stdout, stderr: result.stderr })}\n`,
      );
    assert.ifError(result.error);
    assert.equal(
      result.status,
      expectedStatus,
      `${args.join(" ")}: ${result.stdout}\n${result.stderr}`,
    );
    return json
      ? JSON.parse(result.stdout)
      : result.stdout + (expectedStatus === 0 ? "" : result.stderr);
  };
}

function verifyDefaults({ root, env }, run) {
  const project = join(root, "default consumer with spaces");
  const linked = join(root, "default linked with spaces");
  prepareRepository(project, env);
  try {
    const adopted = run(project, ["workspace", "setup", "--json"], true).workspace;
    assert.equal(adopted.preparation, "ready");
    assert.equal(adopted.recipe, "defaults");
    assert.deepEqual(adopted.ports, {});
    run(project, ["workspace", "setup", "-c", "default-child", "--path", linked, "--json"], true);
    assert.equal(realpathSync(join(linked, ".plans")), join(project, ".plans"));
    assert.equal(run(project, ["workspace", "list", "--json"], true).workspaces.length, 2);
    run(linked, ["workspace", "teardown", "--json"], true);
    assert(existsSync(linked), "teardown preserves Git/files");
    run(project, ["workspace", "remove", linked, "--json"], true);
    assert(!existsSync(linked));
    assert(existsSync(join(project, ".plans", "preserved.txt")));
    assertNoNodeProject(project);
  } finally {
    if (existsSync(linked))
      run(project, ["workspace", "remove", linked, "--force", "--json"], true);
    run(project, ["workspace", "teardown", "--json"], true);
  }
}

function verifyPythonMonorepo({ root, env, evidence }, run) {
  const project = join(root, "python monorepo with spaces");
  const linked = join(root, "python linked with spaces");
  prepareRepository(project, env, true);
  try {
    run(project, ["workspace", "setup", "--full", "--json"], true);
    run(
      project,
      ["workspace", "setup", "-c", "python-child", "--path", linked, "--full", "--json"],
      true,
    );
    const records = [project, linked].map(
      (cwd) => run(cwd, ["workspace", "status", "--json"], true).workspace,
    );
    assert.notEqual(records[0].ports.api, records[1].ports.api);
    const pids = [project, linked].flatMap((cwd, index) => {
      assertNoNodeProject(cwd);
      run(cwd, ["dev", "up"]);
      const owned = verifyPythonServices(cwd, records[index], env, evidence);
      verifyPythonTransform(cwd, records[index], run);
      return owned;
    });
    assert.notEqual(
      realpathSync(join(project, ".local-wt/data")),
      realpathSync(join(linked, ".local-wt/data")),
    );
    assert.equal(realpathSync(join(linked, ".plans")), join(project, ".plans"));
    run(project, ["dev", "down"]);
    assert(
      !executing(pids[0]) && !executing(pids[1]),
      "down terminates both owned Python processes",
    );
    run(linked, ["workspace", "remove", "--force", "--json"], true);
    assert(!existsSync(linked));
    assert(
      pids.every((pid) => !executing(pid)),
      "removal terminates linked Python processes",
    );
    assert.equal(
      readFileSync(join(project, ".plans/preserved.txt"), "utf8"),
      "shared plans survive\n",
    );
  } finally {
    // Retry cleanup before removing fixture files, including partial startup failures.
    run(project, ["dev", "down", "--all"]);
    if (existsSync(linked))
      run(project, ["workspace", "remove", linked, "--force", "--json"], true);
    run(project, ["workspace", "teardown", "--json"], true);
  }
}

function verifyCompanion(options) {
  const { root } = options;
  const project = join(root, "companion consumer with spaces");
  const linked = [join(root, "first companion child"), join(root, "second companion child")];
  const companion = join(root, "companion home/.alignfirst/companions/fixture");
  const env = { ...options.env, HOME: join(root, "companion home"), PACKED_DEV_LIMIT: "invalid" };
  const run = cliRunner({ ...options, env });
  const config = prepareCompanion(project, companion, env);
  const reports = new Map();
  const events = () =>
    readFileSync(join(companion, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  let cleaned = false;
  try {
    const nested = join(project, "nested/cwd");
    const report = run(nested, ["config", "--json"], true);
    assert.deepEqual(
      report.config,
      config,
      "report preserves the complete authored recipe/binding",
    );
    assert.equal(report.source, "companion");
    assert.equal(report.companion.defaultLocation, "companion");
    assert.equal(report.selectionOrigins.workspaceRuntime, "defaultLocation");
    assert.equal(report.locations.developerInstructions.path, join(companion, "team-notes.txt"));
    assert.equal(report.locations.workspaceRuntime.in, "companion");
    const instructions = run(nested, ["developer-instructions"]);
    assert.match(instructions, /Ticket IDs: `\^PACK-\\d\+\$`/);
    assert(instructions.includes(`Source: ${join(companion, "team-notes.txt")}`));
    assert(instructions.endsWith("Companion instructions sentinel.\n"));
    assert(!instructions.includes("# Docmap"));
    assert(!existsSync(join(companion, "events.jsonl")), "inspection executes no hooks");
    assert(!existsSync(join(companion, ".local-wt")), "inspection creates no runtime storage");
    env.PACKED_DEV_LIMIT = "1";
    run(project, ["workspace", "setup", "--json"], true);
    for (const [index, target] of linked.entries()) {
      run(
        project,
        [
          "workspace",
          "setup",
          "-c",
          `companion-${index}`,
          "--path",
          target,
          "--full",
          "--detached",
          "--json",
        ],
        true,
      );
      run(project, ["workspace", "wait", target, "--json"], true);
    }
    for (const target of [project, ...linked]) {
      const current = run(join(target, "nested/cwd"), ["config", "--json"], true);
      reports.set(target, current);
      assert.equal(current.workspace.registryDir, report.workspace.registryDir);
      assert(!existsSync(join(target, ".local-wt")), "no checkout runtime directory/link");
      assert(
        !existsSync(join(current.workspace.runtimeDir, "workspace-registry")),
        "registry is directly addressed",
      );
      assert.equal(readFileSync(join(current.workspace.runtimeDir, "resource"), "utf8"), target);
    }
    assert.equal(new Set([...reports.values()].map((item) => item.workspace.runtimeDir)).size, 3);
    for (const event of events()) verifyCompanionContext(event, companion, reports);
    const firstRuntime = reports.get(linked[0]).workspace.runtimeDir;
    const secondRuntime = reports.get(linked[1]).workspace.runtimeDir;
    writeFileSync(join(firstRuntime, "fail-node"), "startup detector\n");
    assert.match(run(linked[0], ["dev", "up"], false, 1), /SyntaxError/);
    rmSync(join(firstRuntime, "fail-node"));
    run(linked[0], ["dev", "up"]);
    assert.match(run(linked[1], ["dev", "up"], false, 1), /cap reached \(1\/1\)/);
    const service = JSON.parse(readFileSync(join(firstRuntime, "service.json"), "utf8"));
    assert(executing(service.pid));
    run(project, ["dev", "down", "--all"]);
    assert(!executing(service.pid), "cross-target stop terminates the owned service");
    run(project, ["workspace", "teardown", linked[0], "--json"], true);
    assert(existsSync(firstRuntime), "teardown retains runtime/logs");
    assert(existsSync(linked[0]), "teardown retains Git checkout");
    run(project, ["workspace", "remove", linked[0], "--force", "--json"], true);
    assert(!existsSync(linked[0]) && !existsSync(firstRuntime));
    assert.equal(
      readFileSync(join(secondRuntime, "resource"), "utf8"),
      linked[1],
      "remove preserves the sibling resource sentinel",
    );
    writeFileSync(join(secondRuntime, "fail-purge"), "fail once\n");
    assert.match(
      run(project, ["workspace", "teardown", linked[1], "--json"], false, 1),
      /intentional packed purge failure/,
    );
    const registry = JSON.parse(
      readFileSync(join(report.workspace.registryDir, "workspaces.json"), "utf8"),
    );
    assert.equal(registry.version, 4);
    assert(
      Object.values(registry.workspaces).some(
        (entry) => entry.worktree === linked[1] && entry.cleanupPending,
      ),
    );
    assert(
      Object.values(registry.runtimeOwners).some(
        (owner) => owner.worktree === linked[1] && owner.state === "active",
      ),
    );
    assert(
      existsSync(join(secondRuntime, "resource")),
      "failed cleanup preserves resource evidence",
    );
    rmSync(join(secondRuntime, "fail-purge"));
    run(project, ["workspace", "teardown", linked[1], "--json"], true);
    assert(!existsSync(join(secondRuntime, "resource")));
    assert(existsSync(secondRuntime));
    execFileSync("git", ["worktree", "remove", "--force", linked[1]], { cwd: project, env });
    const orphan = run(project, ["workspace", "list", "--json"], true).workspaces.find(
      (row) => row.path === linked[1],
    );
    assert.equal(orphan.name, null);
    assert.equal(orphan.runtimeState, "retained");
    assert.equal(orphan.runtimeDir, secondRuntime);
    const purgeCount = events().filter((event) => event.context.phase === "purge").length;
    assert.deepEqual(run(project, ["workspace", "prune", "--json"], true).pruned, [
      { path: linked[1], name: null },
    ]);
    assert.equal(events().filter((event) => event.context.phase === "purge").length, purgeCount);
    assert(!existsSync(secondRuntime));
    assert(existsSync(report.workspace.registryDir));
    assert.equal(
      readFileSync(join(reports.get(project).workspace.runtimeDir, "resource"), "utf8"),
      project,
      "prune preserves main's resource sentinel",
    );
    for (const event of events()) verifyCompanionContext(event, companion, reports);
    assert.equal(
      readFileSync(join(companion, ".plans/preserved.txt"), "utf8"),
      "companion plans survive\n",
    );
    assert(
      events()
        .filter((event) => event.context.phase === "purge")
        .every((event) => event.targetExists),
      "purge precedes Git deletion",
    );
    cleaned = true;
  } finally {
    for (const current of reports.values()) {
      rmSync(join(current.workspace.runtimeDir, "fail-purge"), { force: true });
      rmSync(join(current.workspace.runtimeDir, "fail-node"), { force: true });
    }
    run(project, ["dev", "down", "--all"]);
    for (const target of linked) {
      if (existsSync(target)) run(project, ["workspace", "wait", target, "--json"], true);
      if (existsSync(target))
        run(project, ["workspace", "remove", target, "--force", "--json"], true);
    }
    run(project, ["workspace", "prune", "--json"], true);
    run(project, ["workspace", "teardown", "--json"], true);
    const owned = existsSync(join(companion, "events.jsonl")) ? events() : [];
    assert(
      owned.every((event) => !executing(event.pid)),
      "all companion hook/service PIDs exited",
    );
    if (options.evidence !== undefined)
      appendFileSync(
        options.evidence,
        `${JSON.stringify({ kind: "companionCleanup", cleaned, pids: owned.map((event) => event.pid), reports: [...reports.entries()] })}\n`,
      );
  }
  console.log(
    "PASS packed companion configuration/instructions, detached setup, numeric cap, service stop, cleanup retry and runtime-only prune",
  );
}

function prepareCompanion(project, companion, env) {
  prepareRepository(project, env);
  mkdirSync(join(project, "nested/cwd"), { recursive: true });
  writeFileSync(join(project, "nested/cwd/tracked.txt"), "nested cwd\n");
  writeFileSync(join(project, ".gitignore"), ".plans/\n");
  writeFileSync(
    join(project, "alignfirst.json"),
    JSON.stringify({ schemaVersion: 1, conventions: { ticketIdPattern: "^DECOY$" } }),
  );
  execFileSync("git", ["add", "."], { cwd: project, env });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Acceptance",
      "-c",
      "user.email=acceptance@example.invalid",
      "-c",
      "commit.gpgSign=false",
      "commit",
      "--quiet",
      "-m",
      "nested fixture",
    ],
    { cwd: project, env },
  );
  mkdirSync(join(companion, "scripts"), { recursive: true });
  mkdirSync(join(companion, ".plans"));
  writeFileSync(join(companion, ".plans/preserved.txt"), "companion plans survive\n");
  writeFileSync(join(companion, "team-notes.txt"), "Companion instructions sentinel.\n");
  writeFileSync(
    join(env.HOME, ".alignfirst/companions/registry.json"),
    JSON.stringify({ projects: { [project]: { dir: companion, defaultLocation: "companion" } } }),
  );
  writeFileSync(
    join(companion, "scripts/helper.mjs"),
    `import {appendFileSync,existsSync,rmSync,writeFileSync} from "node:fs";
const context=JSON.parse(process.env.ALIGNFIRST_WORKSPACE_CONTEXT);
if(process.env.ALIGNFIRST_CONTEXT!==undefined) throw new Error("retired ABI leaked");
appendFileSync(context.companionDir+"/events.jsonl",JSON.stringify({context,cwd:process.cwd(),pid:process.pid,targetExists:existsSync(context.currentWorktree)})+"\\n");
if(context.phase==="finalize") writeFileSync(context.runtimeDir+"/resource",context.currentWorktree);
if(context.phase==="purge") {
  if(existsSync(context.runtimeDir+"/fail-purge")) throw new Error("intentional packed purge failure");
  rmSync(context.runtimeDir+"/resource",{force:true});
}
if(process.argv[2]==="serve") {
  writeFileSync(context.runtimeDir+"/service.json",JSON.stringify({pid:process.pid,context,cwd:process.cwd()}));
  console.log(existsSync(context.runtimeDir+"/fail-node")?"SyntaxError: packed startup sentinel":"COMPANION_READY");
  setInterval(()=>{},1000);
}
`,
  );
  const command = (action) => ({
    // biome-ignore lint/suspicious/noTemplateCurlyInString: authored workspace interpolation
    run: [process.execPath, "${{ configurationDir }}/scripts/helper.mjs", action],
  });
  const config = {
    schemaVersion: 1,
    conventions: { ticketIdPattern: "^PACK-\\d+$", git: { defaultBranch: "main" } },
    developerInstructions: "team-notes.txt",
    workspace: {
      finalize: [{ name: "companion finalize", ...command("finalize") }],
      purge: [{ name: "companion purge", ...command("purge") }],
    },
    devServer: {
      maxConcurrentDevServers: { env: "PACKED_DEV_LIMIT", default: 0 },
      setup: [{ name: "companion dev setup", ...command("setup") }],
      servers: [
        {
          kind: "spawn",
          name: "companion-service",
          exec: command("serve"),
          ready: { log: "COMPANION_READY" },
          error: { preset: "node" },
        },
      ],
    },
  };
  writeFileSync(join(companion, "alignfirst.json"), JSON.stringify(config));
  return config;
}

function verifyCompanionContext({ context, cwd }, companion, reports) {
  assert.equal(cwd, context.currentWorktree, "companion helper runs in the real target checkout");
  assert.equal(context.configurationDir, companion);
  assert.equal(context.companionDir, companion);
  assert.equal(context.runtimeDir, reports.get(cwd).workspace.runtimeDir);
}

function verifyPythonServices(cwd, record, env, evidence) {
  const identity = JSON.parse(readFileSync(join(cwd, ".local-wt/data/identity.json"), "utf8"));
  assert.equal(identity.name, record.name);
  assert.equal(identity.currentWorktree, cwd);
  const pids = ["api", "worker"].map((role) => {
    const service = JSON.parse(readFileSync(join(cwd, `.local-wt/${role}.json`), "utf8"));
    if (evidence !== undefined)
      appendFileSync(evidence, `${JSON.stringify({ kind: "pythonService", ...service })}\n`);
    assert.equal(service.context.name, record.name);
    assert.deepEqual(service.context.ports, record.ports);
    assert.equal(service.context.currentWorktree, cwd);
    assert.equal(service.cwd, join(cwd, "packages", role));
    assert.equal(service.prefix, join(cwd, ".venv"));
    assert.equal(service.role, role);
    assert.equal(service.message, `shared:${role}`);
    return service.pid;
  });
  const response = JSON.parse(
    execFileSync(
      "python3",
      [
        "-c",
        `import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:${record.ports.api}').read().decode())`,
      ],
      { env, encoding: "utf8" },
    ),
  );
  assert.equal(response.context.name, record.name);
  if (evidence !== undefined)
    appendFileSync(evidence, `${JSON.stringify({ kind: "pythonHttpResponse", response })}\n`);
  return pids;
}

function verifyPythonTransform(cwd, record, run) {
  const config = join(cwd, ".local-wt/application.json");
  writeFileSync(
    config,
    JSON.stringify({
      ...JSON.parse(readFileSync(config, "utf8")),
      local: "unrelated local edit",
    }),
  );
  run(cwd, ["dev", "setup"]);
  const once = readFileSync(config, "utf8");
  run(cwd, ["dev", "setup"]);
  assert.equal(readFileSync(config, "utf8"), once, "Python transform is idempotent");
  assert.equal(JSON.parse(once).local, "unrelated local edit");
  assert.equal(JSON.parse(once).port, record.ports.api);
}

function prepareRepository(root, env, python = false) {
  mkdirSync(root, { recursive: true });
  if (python)
    cpSync(join(import.meta.dirname, "fixtures/python-monorepo"), root, { recursive: true });
  mkdirSync(join(root, ".plans"));
  writeFileSync(join(root, ".plans/preserved.txt"), "shared plans survive\n");
  writeFileSync(join(root, ".gitignore"), ".plans/\n.local-wt/\n.venv/\n__pycache__/\n");
  for (const args of [
    ["init", "--quiet", "-b", "main"],
    ["add", "."],
    [
      "-c",
      "user.name=Acceptance",
      "-c",
      "user.email=acceptance@example.invalid",
      "-c",
      "commit.gpgSign=false",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ],
  ])
    execFileSync("git", args, { cwd: root, env });
}

function assertNoNodeProject(root) {
  for (const path of ["package.json", "node_modules", "dist"])
    assert(!existsSync(join(root, path)), `Consumer unexpectedly needs ${path}`);
}

function executing(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
  } catch {
    return false;
  }
}
