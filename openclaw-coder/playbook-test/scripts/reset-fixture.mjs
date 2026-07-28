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

const PROJECTS = "/home/claw/projects";
const TEMPLATE = "/opt/playbook-test/fixtures/template";
const FIXTURES = ["nimbus", "lumen"];
// Each fixture's `origin` is a bare repo alongside its working tree, so
// `git fetch` + `git merge --ff-only origin/main` behave like a real up-to-date
// clone (a remote-less fixture made the playbook's new-work path — fetch +
// fast-forward the base — hard-fail with "origin/main - not something we can
// merge"). Kept out of PROJECTS so it never reads as a project directory.
const ORIGINS = "/home/claw/.fixture-origins";
const BASE_BRANCH = "main";

async function main() {
  // Stop dev-servers from the prior run before wiping. Configured fixtures
  // know their `dev down --all`; for any stray dir we kill anything still
  // listening best-effort.
  for (const name of FIXTURES) {
    const dst = `${PROJECTS}/${name}`;
    if (existsSync(dst)) {
      await runWithTimeout("pnpm", ["-C", dst, "dev", "down", "--all"], 10_000);
    }
  }
  // Wipe everything under PROJECTS and the fixture origins unconditionally. The
  // fixture template lives in /opt/playbook-test/fixtures/ and is re-copied below.
  // pnpm's store is pinned to /home/claw/.pnpm-store via ~/.npmrc, so nothing
  // here is worth keeping.
  for (const entry of readdirSync(PROJECTS)) {
    rmSync(`${PROJECTS}/${entry}`, { recursive: true, force: true });
  }
  rmSync(ORIGINS, { recursive: true, force: true });
  mkdirSync(ORIGINS, { recursive: true });
  for (const name of FIXTURES) {
    await resetFixture(name);
  }
}

async function resetFixture(name) {
  const dst = `${PROJECTS}/${name}`;
  cpSync(TEMPLATE, dst, { recursive: true, preserveTimestamps: true });
  patchFixture(dst, name);
  // alcode refuses to run outside a project that has a `.plans/` directory
  // (its coaching-session logs land there). Seed an empty one — the fixture's
  // .gitignore already ignores `.plans/`, so it stays untracked like a real
  // repo; the agent runs alcode from this project root (~/projects/<name>).
  mkdirSync(`${dst}/.plans`, { recursive: true });
  // The main worktree never runs `workspace setup`, so seed its `local.env`
  // (gitignored) from the committed example — the base slot's port. Linked
  // worktrees get theirs generated per slot by the workspace tooling.
  cpSync(`${dst}/local.env.example`, `${dst}/local.env`);
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
  // A `production` branch too, so the remote matches DEVELOPMENT.md's convention
  // (base `main`, production `production`) and `git branch -a` reads realistically.
  runGit(dst, ["push", "-q", "origin", `${BASE_BRANCH}:refs/heads/production`], gitEnv);
  runGit(dst, ["remote", "set-head", "origin", BASE_BRANCH], gitEnv);
}

// Per-name patches applied to the materialized copy of the shared template.
// Only the package `name` and the welcome H1 diverge — the live directory name
// is what actually matters. Patching only the `name` field keeps the frozen
// lockfile valid, so a single build-time install serves both projects.
function patchFixture(dst, name) {
  const pkgPath = `${dst}/package.json`;
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.name = `@playbook-test/${name}-fixture`;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  const devDocPath = `${dst}/DEVELOPMENT.md`;
  const capitalized = name.charAt(0).toUpperCase() + name.slice(1);
  const devDoc = readFileSync(devDocPath, "utf8").replace(
    /^# Developing$/m,
    `# Developing ${capitalized}`,
  );
  writeFileSync(devDocPath, devDoc);
}

function runGit(cwd, args, env) {
  const r = spawnSync("git", args, { cwd, env, stdio: "inherit" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} (cwd=${cwd}) exited ${r.status}`);
  }
}

function runWithTimeout(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "ignore" });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
