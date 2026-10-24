import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { WorkspacesRegistry } from "../../src/workspaces.js";

/** Repo root of `@alignfirst/workspace`, resolved from this file's location. */
export const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export const cliExecutable = process.env.WORKSPACE_CLI_EXECUTABLE ?? process.execPath;
if (!existsSync(cliExecutable)) throw new Error(`Missing workspace CLI runtime: ${cliExecutable}`);
const runtimeProbe = spawnSync(
  cliExecutable,
  ["-p", "JSON.stringify({bun:process.versions.bun,executable:process.execPath})"],
  { encoding: "utf8" },
);
if (runtimeProbe.status !== 0)
  throw new Error(`Workspace CLI runtime failed: ${runtimeProbe.stderr}`);
export const cliRuntime: { bun?: string; executable: string } = JSON.parse(runtimeProbe.stdout);

// CLI children import the built package under the selected runtime.
const distIndexUrl = pathToFileURL(join(packageRoot, "dist", "index.js")).href;

/** The fixture dev-server's port range, and the port it excludes. */
export const DEV_PORTS = { first: 47100, last: 47109, excluded: 47101 };

/**
 * A real dev-server with no server: `dev setup` alone exercises it. Its run file `ports.env` carries
 * the ports through a patch. `ports.txt` is generated without a patch, from the web port and the
 * `E2E_HOST` input (default `localhost`). Its `setup`
 * hook appends one line per run to `setup-runs.log`, and throws with `E2E_DEV_SETUP_FAIL=1`, with a
 * message that ends with a period. With `E2E_DEV_EXIT=1`, it exits with code 3 before recording
 * anything. `E2E_CALLBACK_LIFECYCLE=1` enables logging callbacks and a ready-marker spawn server;
 * `E2E_READY_BARRIER` and `E2E_DEV_SETUP_BARRIER` hold readiness and setup respectively.
 */
const DEV_SERVER_MJS_SOURCE = `import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
    {
      path: "ports.txt",
      source: {
        kind: "content",
        content: (ctx) =>
          "web=" + (process.env.E2E_HOST ?? "localhost") + ":" + ctx.ports.web + "\\n",
      },
    },
  ],
  runFilesInputs: () => ({ E2E_HOST: process.env.E2E_HOST }),
  setup: async (ctx) => {
    if (process.env.E2E_DEV_SETUP_BARRIER !== undefined) {
      const barrier = process.env.E2E_DEV_SETUP_BARRIER;
      writeFileSync(barrier + ".entered", String(process.pid));
      const deadline = Date.now() + 30_000;
      while (!existsSync(barrier)) {
        if (Date.now() > deadline) throw new Error("e2e dev setup barrier timed out");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    if (process.env.E2E_DEV_SETUP_FAIL === "1") throw new Error("e2e dev boom.");
    appendFileSync(join(ctx.currentWorktree, "setup-runs.log"), "force=" + ctx.force + "\\n");
  },
  maxConcurrentDevServers: process.env.E2E_DEV_CAP === undefined
    ? undefined : Number(process.env.E2E_DEV_CAP),
  servers: process.env.E2E_CALLBACK_LIFECYCLE === "1" ? [
    ...["docker", "cache"].map((label) => ({
      kind: "callback",
      name: label,
      start: async (ctx) => {
        recordCallback("start", ctx, label);
        if (process.env.E2E_CALLBACK_START_FAIL === label) throw new Error("e2e callback start boom");
      },
      stop: async (ctx) => recordCallback("stop", ctx, label),
    })),
    {
      kind: "callback",
      name: "legacy",
      start: async ({ cwd, ports }) => recordCallback("legacyStart", { cwd, ports }),
      stop: async ({ cwd, ports }) => recordCallback("legacyStop", { cwd, ports }),
    },
    {
      kind: "spawn",
      name: "ready",
      exec: { command: process.execPath, args: ["scripts/ready-server.mjs"] },
      detectReady: (log) => log.includes("FIXTURE_READY"),
    },
  ] : process.env.E2E_CALLBACK_RECORD === "1" ? [{
    kind: "callback",
    name: "fixture",
    start: (ctx) => recordCallback("start", ctx),
    stop: (ctx) => recordCallback("stop", ctx),
  }] : [],
});

function recordCallback(event, ctx, label) {
  const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: ctx.cwd, encoding: "utf-8",
  }).trim();
  appendFileSync(join(dirname(common), "callback-runs.jsonl"), JSON.stringify({ event, ...ctx, ...(label === undefined ? {} : { label }) }) + "\\n");
  if (event === "stop" && process.env.E2E_CALLBACK_STOP_FAIL === "1") {
    throw new Error("e2e callback stop boom");
  }
}
`;

// Opt-in lifecycle server: records its actual cwd and waits on a controllable readiness barrier.
const READY_SERVER_MJS_SOURCE = `import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
  encoding: "utf-8",
}).trim();
appendFileSync(join(dirname(common), "spawn-runs.jsonl"), JSON.stringify({
  pid: process.pid, cwd: process.cwd(),
}) + "\\n");
const deadline = Date.now() + 30_000;
while (process.env.E2E_READY_BARRIER !== undefined && !existsSync(process.env.E2E_READY_BARRIER)) {
  if (Date.now() > deadline) throw new Error("e2e readiness barrier timed out");
  await new Promise((resolve) => setTimeout(resolve, 25));
}
if (process.env.E2E_RESIST_TERM === "1") process.on("SIGTERM", () => {});
console.log("FIXTURE_READY");
setInterval(() => {}, 1000);
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
  /** Shared directories for external-worktree link coverage. */
  sharedDirs?: string[];
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
    workspaceMjsSource(portless, fallbackSeeding, oldConfig, options.sharedDirs ?? []),
  );
  if (fallbackSeeding) {
    writeFileSync(join(repo, "workspace.template"), "committed-template\n");
  }
  writeFileSync(
    join(repo, ".gitignore"),
    "workspace.local\nports.env\nports.txt\nsetup-runs.log\n",
  );
  if (!portless) {
    writeFileSync(join(repo, "scripts", "dev-server.mjs"), DEV_SERVER_MJS_SOURCE);
    writeFileSync(join(repo, "scripts", "ready-server.mjs"), READY_SERVER_MJS_SOURCE);
  }
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
  sharedDirs: string[],
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
  return `import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runWorkspace } from "${distIndexUrl}";

await runWorkspace({
  workspaceScript: fileURLToPath(import.meta.url),
${devSetup}${oldPorts}  sharedDirs: ${JSON.stringify(sharedDirs)},
  gitignoredFiles: ${gitignoredFiles},
  runtimeDir: ".wt",
  formatSummary: () => "Workspace ready.",
  purgeInfrastructure: (ctx) => {
    appendFileSync(join(ctx.mainWorktree, "purge-runs.jsonl"), JSON.stringify(ctx) + "\\n");
    if (process.env.E2E_PURGE_FAIL === "1") throw new Error("e2e purge boom");
    if (process.env.E2E_PURGE_RECREATE_WORKTREE === "1") mkdirSync(ctx.worktree, { recursive: true });
  },
  finalizeWorkspace: async (ctx) => {
    if (process.env.E2E_FINALIZE_PID_LOG === "1") {
      appendFileSync(join(ctx.mainWorktree, "finalize-pids.jsonl"), JSON.stringify(process.pid) + "\\n");
    }
    if (process.env.E2E_FINALIZE_BARRIER !== undefined) {
      const barrier = process.env.E2E_FINALIZE_BARRIER;
      writeFileSync(barrier + ".entered", String(process.pid));
      const deadline = Date.now() + 30_000;
      while (!existsSync(barrier)) {
        if (Date.now() > deadline) throw new Error("e2e finalize barrier timed out");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.E2E_FINALIZE_DELAY_MS ?? 0)));
    if (process.env.E2E_FINALIZE_FAIL === "1") throw new Error("e2e boom");
    ctx.progress("step-one");
    writeFileSync(join(ctx.currentWorktree, "finalized.txt"), "finalized\\n");
    writeFileSync(join(ctx.currentWorktree, "finalize-context.json"), JSON.stringify({
      name: ctx.name, currentWorktree: ctx.currentWorktree, mainWorktree: ctx.mainWorktree,
      isMainWorktree: ctx.isMainWorktree, branch: ctx.branch,
    }));
  },
});
`;
}

/** Runs the fixture CLI as a `node` subprocess with piped (non-TTY) stdio. */
export function runCli(
  repo: string,
  args: string[],
  env?: Record<string, string>,
  cwd: string = repo,
): SpawnSyncReturns<string> {
  return spawnSync(cliExecutable, [join(repo, "scripts", "workspace.mjs"), ...args], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, E2E_FINALIZE_PID_LOG: "1", ...env },
    stdio: "pipe",
    timeout: 60_000,
  });
}

/** Runs the fixture's `dev-server.mjs` in `worktree`. */
export function runDev(
  worktree: string,
  args: string[],
  env?: Record<string, string>,
  cwd: string = worktree,
): SpawnSyncReturns<string> {
  return spawnSync(cliExecutable, [join(worktree, "scripts", "dev-server.mjs"), ...args], {
    cwd,
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
