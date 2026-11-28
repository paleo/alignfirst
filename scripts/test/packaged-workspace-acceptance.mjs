import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function verifyPackagedWorkspaces(options) {
  verifyDefaults(options, cliRunner(options));
  console.log("PASS packed default workspace lifecycle: setup, list, teardown, remove");
}

function cliRunner({ executable, entry, env, evidence }) {
  return (cwd, args) => {
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
    return JSON.parse(result.stdout);
  };
}

function verifyDefaults({ root, env }, run) {
  const project = join(root, "default consumer with spaces");
  const linked = join(root, "default linked with spaces");
  prepareRepository(project, env);
  try {
    const adopted = run(project, ["workspace", "setup", "--json"]).workspace;
    assert.equal(adopted.preparation, "ready");
    assert.equal(adopted.recipe, "defaults");
    assert.deepEqual(adopted.ports, {});
    run(project, ["workspace", "setup", "-c", "default-child", "--path", linked, "--json"]);
    assert.equal(realpathSync(join(linked, ".plans")), join(project, ".plans"));
    assert.equal(run(project, ["workspace", "list", "--json"]).workspaces.length, 2);
    run(linked, ["workspace", "teardown", "--json"]);
    assert(existsSync(linked), "teardown preserves Git/files");
    run(project, ["workspace", "remove", linked, "--json"]);
    assert(!existsSync(linked));
    assert(existsSync(join(project, ".plans", "preserved.txt")));
    assertNoNodeProject(project);
  } finally {
    if (existsSync(linked)) run(project, ["workspace", "remove", linked, "--force", "--json"]);
    run(project, ["workspace", "teardown", "--json"]);
  }
}

function prepareRepository(root, env) {
  mkdirSync(root, { recursive: true });
  mkdirSync(join(root, ".plans"));
  writeFileSync(join(root, ".plans/preserved.txt"), "shared plans survive\n");
  writeFileSync(join(root, ".gitignore"), ".plans/\n.local-wt/\n");
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
