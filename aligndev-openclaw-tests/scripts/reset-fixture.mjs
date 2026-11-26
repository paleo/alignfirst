#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { FIXTURE_PORT_RANGES, patchDevServerRange } from "./fixture-personalization.ts";

const TEMPLATE =
  process.env.ALIGNDEV_FIXTURE_TEMPLATE ?? "/opt/aligndev-openclaw-tests/fixtures/template";
const PRIMARY = process.env.ALIGNDEV_FIXTURE_PROJECTS ?? "/home/assistant/projects";
const EXTERNAL = `${PRIMARY}/external-projects`;
const LIFECYCLE = `${PRIMARY}/lifecycle-projects`;
const FIXTURES = [
  { name: "nimbus", parent: PRIMARY },
  { name: "lumen", parent: PRIMARY },
  { name: "orion", parent: EXTERNAL },
];
// Each fixture's `origin` is a bare repo alongside its working tree, so
// `git fetch` + `git merge --ff-only origin/main` behave like a real up-to-date
// clone (a remote-less fixture made the playbook's new-work path — fetch +
// fast-forward the base — hard-fail with "origin/main - not something we can
// merge"). Kept out of PROJECTS so it never reads as a project directory.
const ORIGINS = process.env.ALIGNDEV_FIXTURE_ORIGINS ?? "/home/assistant/.fixture-origins";
const BASE_BRANCH = "main";

async function main() {
  // Recover missing targets before stopping survivors, while cleanup recipes still exist.
  const projects = gitProjects(PRIMARY);
  for (const dst of projects) {
    if (existsSync(dst)) {
      await runWithTimeout("alignfirst", ["workspace", "prune"], 30_000, dst);
      await runWithTimeout("alignfirst", ["dev", "down", "--all"], 30_000, dst);
      const inventory = spawnSync("alignfirst", ["workspace", "list", "--json"], {
        cwd: dst,
        encoding: "utf8",
      });
      if (inventory.error !== undefined || inventory.status !== 0) {
        throw new Error(`Cannot inspect fixture cleanup in ${dst}: ${inventory.stderr}`);
      }
      for (const workspace of JSON.parse(inventory.stdout).workspaces) {
        if (workspace.name !== null) {
          await runWithTimeout(
            "alignfirst",
            ["workspace", "teardown", workspace.path],
            30_000,
            dst,
          );
        }
      }
      await runWithTimeout("alignfirst", ["workspace", "prune"], 30_000, dst);
    }
  }
  // Wipe everything under the fixture root and origins unconditionally. The
  // fixture template lives in /opt/aligndev-openclaw-tests/fixtures/ and is re-copied below.
  // pnpm's store is pinned to /home/assistant/.pnpm-store by the image's pnpm config, so nothing
  // here is worth keeping.
  for (const entry of readdirSync(PRIMARY)) {
    rmSync(`${PRIMARY}/${entry}`, { recursive: true, force: true });
  }
  mkdirSync(EXTERNAL, { recursive: true });
  mkdirSync(LIFECYCLE, { recursive: true });
  rmSync(ORIGINS, { recursive: true, force: true });
  mkdirSync(ORIGINS, { recursive: true });
  for (const fixture of FIXTURES) {
    await resetFixture(fixture);
  }
}

function gitProjects(directory) {
  if (!existsSync(directory)) return [];
  if (existsSync(`${directory}/.git`)) return [directory];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => gitProjects(`${directory}/${entry.name}`));
}

async function resetFixture({ name, parent }) {
  const dst = `${parent}/${name}`;
  cpSync(TEMPLATE, dst, { recursive: true, preserveTimestamps: true });
  patchFixture(dst, name);
  // `aligndev code` refuses to run outside a project that has a `.plans/` directory
  // (its coaching-session logs land there). Seed an empty one — the fixture's
  // .gitignore already ignores `.plans/`, so it stays untracked like a real
  // repo; the agent runs `aligndev code` from this project's canonical main path.
  mkdirSync(`${dst}/.plans`, { recursive: true });
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@local",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@local",
  };
  runGit(dst, ["init", "-q", "-b", BASE_BRANCH], gitEnv);
  runGit(dst, ["add", "-A"], gitEnv);
  runGit(dst, ["commit", "-q", "-m", "fixture init"], gitEnv);

  // Bare `origin` seeded with the fixture's initial commit, so the working tree
  // is an up-to-date clone: `git fetch` finds the remote and
  // `git merge --ff-only origin/<base>` is a clean no-op. `origin/HEAD` points
  // at the base branch so `git remote show origin` reports it as the default.
  const origin = `${ORIGINS}/${name}.git`;
  runGit(dst, ["init", "-q", "--bare", "-b", BASE_BRANCH, origin], gitEnv);
  runGit(dst, ["remote", "add", "origin", origin], gitEnv);
  runGit(dst, ["push", "-q", "-u", "origin", BASE_BRANCH], gitEnv);
  // A `production` branch too, so the remote matches ASSISTANTS.md's convention
  // (base `main`, production `production`) and `git branch -a` reads realistically.
  runGit(dst, ["push", "-q", "origin", `${BASE_BRANCH}:refs/heads/production`], gitEnv);
  runGit(dst, ["remote", "set-head", "origin", BASE_BRANCH], gitEnv);
}

// Per-name patches applied to the materialized copy of the shared template.
// The package `name`, the entry-point H1s and the port block diverge — the live
// directory name is what actually matters. Patching only the `name` field of
// package.json keeps the frozen lockfile valid, so a single build-time install
// serves both projects.
function patchFixture(dst, name) {
  const pkgPath = `${dst}/package.json`;
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.name = `@aligndev-openclaw-tests/${name}-fixture`;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  const config = JSON.parse(readFileSync(`${dst}/alignfirst.json`, "utf8"));
  config.conventions = { ...config.conventions, ticketIdPattern: "^ABC-\\d+$" };
  writeFileSync(`${dst}/alignfirst.json`, `${JSON.stringify(config, null, 2)}\n`);

  // Both entry points name the project, so the three otherwise identical copies
  // read distinctly — the app itself stays the "Comparables" product.
  const capitalized = name.charAt(0).toUpperCase() + name.slice(1);
  patchHeading(`${dst}/README.md`, /^# Comparables$/m, `# ${capitalized}`);
  patchHeading(`${dst}/ASSISTANTS.md`, /^# Assistant Guide$/m, `# ${capitalized} Assistant Guide`);

  patchPortRange(dst, FIXTURE_PORT_RANGES[name]);
}

// An unmatched pattern would ship an unpersonalized fixture, silently weakening
// every scenario that asserts which project the agent read. Fail loudly instead.
function patchHeading(path, pattern, heading) {
  const content = readFileSync(path, "utf8");
  if (!pattern.test(content)) {
    throw new Error(`heading ${pattern} not found in ${path}`);
  }
  writeFileSync(path, content.replace(pattern, heading));
}

function patchPortRange(dst, { first, last }) {
  const path = `${dst}/alignfirst.json`;
  writeFileSync(path, patchDevServerRange(readFileSync(path, "utf8"), first, last));
}

function runGit(cwd, args, env) {
  const r = spawnSync("git", args, { cwd, env, stdio: "inherit" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} (cwd=${cwd}) exited ${r.status}`);
  }
}

function runWithTimeout(cmd, args, timeoutMs, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: "inherit" });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `Fixture cleanup failed in ${cwd}: ${cmd} ${args.join(" ")} (${signal ?? code}); state retained.`,
          ),
        );
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
