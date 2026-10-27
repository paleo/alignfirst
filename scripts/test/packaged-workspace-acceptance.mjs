import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export function verifyPackagedWorkspaces({ executable, entry, root, env, evidence }) {
  const python = spawnSync("python3", ["--version"], { env, encoding: "utf8" });
  assert.ifError(python.error);
  assert.equal(python.status, 0, "python3 is required; Python acceptance is incomplete");
  console.log(`Python prerequisite: ${python.stdout.trim()}`);
  const defaults = join(root, "default consumer with spaces");
  const project = join(root, "python monorepo with spaces");
  const linked = join(root, "python linked with spaces");
  const run = (cwd, args, json = false) => {
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
    assert.equal(result.status, 0, `${args.join(" ")}: ${result.stdout}\n${result.stderr}`);
    return json ? JSON.parse(result.stdout) : result.stdout;
  };
  prepareRepository(defaults, env);
  const defaultChild = join(root, "default linked with spaces");
  try {
    const adopted = run(defaults, ["workspace", "setup", "--json"], true).workspace;
    assert.equal(adopted.preparation, "ready");
    assert.equal(adopted.recipe, "defaults");
    assert.deepEqual(adopted.ports, {});
    run(
      defaults,
      ["workspace", "setup", "-c", "default-child", "--path", defaultChild, "--json"],
      true,
    );
    assert.equal(realpathSync(join(defaultChild, ".plans")), join(defaults, ".plans"));
    assert.equal(run(defaults, ["workspace", "list", "--json"], true).workspaces.length, 2);
    run(defaultChild, ["workspace", "teardown", "--json"], true);
    assert(existsSync(defaultChild), "teardown preserves Git/files");
    run(defaults, ["workspace", "remove", defaultChild, "--json"], true);
    assert(!existsSync(defaultChild));
    assert(existsSync(join(defaults, ".plans", "preserved.txt")));
    assertNoNodeProject(defaults);
  } finally {
    run(defaults, ["workspace", "teardown", "--json"], true);
  }
  prepareRepository(project, env, true);
  const pids = [];
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
    for (const [index, cwd] of [project, linked].entries()) {
      assertNoNodeProject(cwd);
      run(cwd, ["dev", "up"]);
      const identity = JSON.parse(readFileSync(join(cwd, ".local-wt/data/identity.json"), "utf8"));
      assert.equal(identity.name, records[index].name);
      assert.equal(identity.currentWorktree, cwd);
      for (const role of ["api", "worker"]) {
        const service = JSON.parse(readFileSync(join(cwd, `.local-wt/${role}.json`), "utf8"));
        pids.push(service.pid);
        assert.equal(service.context.name, records[index].name);
        assert.deepEqual(service.context.ports, records[index].ports);
        assert.equal(service.context.currentWorktree, cwd);
        assert.equal(service.cwd, join(cwd, "packages", role));
        assert.equal(service.prefix, join(cwd, ".venv"));
        assert.equal(service.role, role);
        assert.equal(service.message, `shared:${role}`);
      }
      const response = JSON.parse(
        execFileSync(
          "python3",
          [
            "-c",
            `import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:${records[index].ports.api}').read().decode())`,
          ],
          { env, encoding: "utf8" },
        ),
      );
      assert.equal(response.context.name, records[index].name);
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
      assert.equal(JSON.parse(once).port, records[index].ports.api);
    }
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
    // Retry cleanup before the caller removes the fixture tree, including partial startup failures.
    run(project, ["dev", "down", "--all"]);
    if (existsSync(linked))
      run(project, ["workspace", "remove", linked, "--force", "--json"], true);
    run(project, ["workspace", "teardown", "--json"], true);
  }
  console.log(
    "PASS packed default lifecycle and package-free Python monorepo: real venv/imports/API/worker, identity/cwd/env/ports, isolation, transform preservation and owned-process cleanup",
  );
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
