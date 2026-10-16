import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { WorkspacesRegistry } from "../../src/workspaces.js";

/** Repo root of `@alignfirst/workspace`, resolved from this file's location. */
export const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

// The fixture's `workspace.mjs` is a plain `node` subprocess, so it imports the *built* package.
const distIndexUrl = pathToFileURL(join(packageRoot, "dist", "index.js")).href;

/** The fixture dev-server's port range, and the port it excludes. */
export const DEV_PORTS = { first: 47100, last: 47109, excluded: 47101 };

/**
 * A real dev-server with no server: `dev setup` alone exercises it. Its run file `ports.env` carries
 * the ports; its `setup` hook appends one line per run to `setup-runs.log`, and throws with
 * `E2E_DEV_SETUP_FAIL=1`, with a message that ends with a period. With `E2E_DEV_EXIT=1`, it exits with code 3 before recording anything.
 */
const DEV_SERVER_MJS_SOURCE = `import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { helpers, runDevServer } from "${distIndexUrl}";

if (process.env.E2E_DEV_EXIT === "1") process.exit(3);

await runDevServer({
  runtimeDir: ".wt",
  ports: {
    first: ${DEV_PORTS.first},
    last: ${DEV_PORTS.last},
    exclude: [${DEV_PORTS.excluded}],
    declare: ["web", "api"],
  },
  runFiles: [
    {
      path: "ports.env",
      source: { kind: "content", content: "# ports\\n" },
      patch: (content, ctx) =>
        helpers.patchEnvFile(content, {
          WEB_PORT: String(ctx.ports.web),
          API_PORT: String(ctx.ports.api),
        }),
    },
  ],
  setup: (ctx) => {
    if (process.env.E2E_DEV_SETUP_FAIL === "1") throw new Error("e2e dev boom.");
    appendFileSync(join(ctx.currentWorktree, "setup-runs.log"), "force=" + ctx.force + "\\n");
  },
  servers: [],
});
`;

export interface FixtureRepo {
  /** The `mkdtemp` root; delete it to clean up. */
  root: string;
  /** The git repo, at `<root>/fixrepo`; worktrees land at `<root>/fixrepo-<branch>`. */
  repo: string;
}

export interface FixtureOptions {
  /** Setup-only variant: no dev-server script. */
  portless?: boolean;
  /**
   * Seeds a gitignored file from a committed fallback or the customized main file. Its patch
   * owns the `worktree=` line and leaves the rest alone, so re-running `setup` can re-apply it.
   * With `E2E_SEED_FAIL=1`, a second entry follows whose required source is missing.
   */
  fallbackSeeding?: boolean;
  /** Declares the `ports` key that 0.37.0 removed from the workspace config. */
  oldConfig?: boolean;
}

export function createFixtureRepo(options: FixtureOptions = {}): FixtureRepo {
  const portless = options.portless ?? false;
  const fallbackSeeding = options.fallbackSeeding ?? false;
  const oldConfig = options.oldConfig ?? false;
  const root = mkdtempSync(join(tmpdir(), "workspace-e2e-"));
  const repo = join(root, "fixrepo");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  writeFileSync(
    join(repo, "scripts", "workspace.mjs"),
    workspaceMjsSource(portless, fallbackSeeding, oldConfig),
  );
  if (fallbackSeeding) {
    writeFileSync(join(repo, "workspace.template"), "committed-template\n");
  }
  writeFileSync(join(repo, ".gitignore"), "workspace.local\nports.env\nsetup-runs.log\n");
  if (!portless) writeFileSync(join(repo, "scripts", "dev-server.mjs"), DEV_SERVER_MJS_SOURCE);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "e2e@example.com"]);
  git(repo, ["config", "user.name", "E2E"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "init"]);
  return { root, repo };
}

function workspaceMjsSource(
  portless: boolean,
  fallbackSeeding: boolean,
  oldConfig: boolean,
): string {
  const devSetup = portless
    ? ""
    : `  devServerScript: fileURLToPath(new URL("./dev-server.mjs", import.meta.url)),
`;
  const oldPorts = oldConfig ? `  ports: { base: 47100, names: ["web"] },\n` : "";
  const gitignoredFiles = fallbackSeeding
    ? `[
    {
      path: "workspace.local",
      source: { kind: "mainWorktree", fallback: "workspace.template" },
      patch: (content, ctx) =>
        content
          .trim()
          .split("\\n")
          .filter((line) => !line.startsWith("worktree="))
          .concat("worktree=" + (ctx.isMainWorktree ? "main" : "linked"))
          .join("\\n") + "\\n",
    },
    ...(process.env.E2E_SEED_FAIL === "1"
      ? [{ path: "required.local", source: { kind: "committed", path: "missing.template" } }]
      : []),
  ]`
    : "[]";
  return `import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runWorkspace } from "${distIndexUrl}";

await runWorkspace({
  workspaceScript: fileURLToPath(import.meta.url),
${devSetup}${oldPorts}  sharedDirs: [],
  gitignoredFiles: ${gitignoredFiles},
  runtimeDir: ".wt",
  formatSummary: () => "Workspace ready.",
  finalizeWorkspace: (ctx) => {
    if (process.env.E2E_FINALIZE_FAIL === "1") throw new Error("e2e boom");
    ctx.progress("step-one");
    writeFileSync(join(ctx.currentWorktree, "finalized.txt"), "finalized\\n");
  },
});
`;
}

/** Runs the fixture CLI as a `node` subprocess with piped (non-TTY) stdio. */
export function runCli(
  repo: string,
  args: string[],
  env?: Record<string, string>,
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [join("scripts", "workspace.mjs"), ...args], {
    cwd: repo,
    encoding: "utf-8",
    env: { ...process.env, ...env },
    stdio: "pipe",
    timeout: 60_000,
  });
}

/** Runs the fixture's `dev-server.mjs` in `worktree`. */
export function runDev(
  worktree: string,
  args: string[],
  env?: Record<string, string>,
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [join("scripts", "dev-server.mjs"), ...args], {
    cwd: worktree,
    encoding: "utf-8",
    env: { ...process.env, ...env },
    stdio: "pipe",
    timeout: 60_000,
  });
}

/** The registry as stored. */
export function readWorkspaces(repo: string): WorkspacesRegistry {
  return JSON.parse(readFileSync(registryPath(repo), "utf-8")) as WorkspacesRegistry;
}

export function writeWorkspaces(repo: string, registry: WorkspacesRegistry): void {
  writeFileSync(registryPath(repo), JSON.stringify(registry, undefined, 2));
}

function registryPath(repo: string): string {
  return join(repo, ".wt", "workspace-registry", "workspaces.json");
}

function git(repo: string, args: string[]): void {
  execFileSync("git", args, { cwd: repo, stdio: "pipe" });
}
