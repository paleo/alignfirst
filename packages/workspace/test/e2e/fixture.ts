import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { WorkspaceManifest, Command } from "../../src/config.js";
import type { WorkspacesRegistry } from "../../src/workspaces.js";

export const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const alignfirstBin = join(packageRoot, "..", "alignfirst", "bin", "alignfirst.mjs");
export const cliExecutable = process.env.WORKSPACE_CLI_EXECUTABLE ?? process.execPath;
if (!existsSync(cliExecutable)) throw new Error(`Missing workspace CLI runtime: ${cliExecutable}`);
const probe = spawnSync(
  cliExecutable,
  ["-p", "JSON.stringify({bun:process.versions.bun,executable:process.execPath})"],
  { encoding: "utf8" },
);
if (probe.status !== 0) throw new Error(`Workspace CLI runtime failed: ${probe.stderr}`);
export const cliRuntime: { bun?: string; executable: string } = JSON.parse(probe.stdout);
export const DEV_PORTS = { first: 47100, last: 47109, excluded: 47101 };

export interface FixtureRepo {
  root: string;
  repo: string;
}

export interface FixtureOptions {
  portless?: boolean;
  fallbackSeeding?: boolean;
  oldConfig?: boolean;
  sharedDirs?: string[];
}

/** Disposable Git, home and project-owned scripts. No consumer wrapper or local dependencies. */
export function createFixtureRepo(options: FixtureOptions = {}): FixtureRepo {
  const root = mkdtempSync(join(tmpdir(), "workspace-e2e-"));
  const repo = join(root, "fixrepo");
  mkdirSync(join(root, "home"));
  mkdirSync(join(repo, "scripts"), { recursive: true });
  mkdirSync(join(repo, ".plans"));
  for (const dir of options.sharedDirs ?? []) mkdirSync(join(repo, dir), { recursive: true });
  const manifest = fixtureManifest(options);
  writeFileSync(join(repo, "scripts", "lifecycle.mjs"), lifecycleSource());
  writeFileSync(join(repo, "scripts", "ready-server.mjs"), readyServerSource());
  if (options.fallbackSeeding)
    writeFileSync(join(repo, "workspace.template"), "committed-template\n");
  writeFileSync(
    join(repo, ".gitignore"),
    `${["/.plans", "/.local", "/.local-wt/", ...(options.sharedDirs ?? []).map((dir) => `/${dir}`), "workspace.local", "required.local", "ports.env", "ports.txt", "setup-runs.log", "finalized.txt", "finalize-context.json", "*-runs.jsonl", "finalize-pids.jsonl"].join("\n")}\n`,
  );
  writeFileSync(
    join(repo, "alignfirst-workspace.json"),
    JSON.stringify(options.oldConfig ? { ...manifest, ports: {} } : manifest),
  );
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "e2e@example.com"]);
  git(repo, ["config", "user.name", "E2E"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "init"]);
  return { root, repo };
}

function fixtureManifest(options: FixtureOptions): WorkspaceManifest {
  const command = (phase: string): Command => ({
    run: [cliExecutable, "scripts/lifecycle.mjs", phase],
  });
  return {
    schemaVersion: 1,
    workspace: {
      sharedDirs: options.sharedDirs,
      gitignoredFiles: options.fallbackSeeding
        ? [
            {
              path: "workspace.local",
              source: { kind: "mainWorktree", fallback: "workspace.template" },
              patch: { command: command("workspacePatch") },
            },
            {
              path: "required.local",
              source: { kind: "content", content: "" },
              patch: { command: command("seedCheck") },
            },
          ]
        : [],
      finalize: [{ name: "step-one", ...command("finalize") }],
      purge: [{ name: "purge", ...command("purge") }],
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Manifest interpolation syntax.
      summary: "Workspace ${{ name }}: ${{ status }} (${{ branch }}).",
    },
    devServer: options.portless
      ? undefined
      : {
          ports: {
            first: DEV_PORTS.first,
            last: DEV_PORTS.last,
            exclude: [DEV_PORTS.excluded],
            declare: ["web", "api"],
          },
          runFiles: [
            {
              path: "ports.env",
              source: { kind: "content", content: "# ports\n" },
              // biome-ignore lint/suspicious/noTemplateCurlyInString: Manifest interpolation syntax.
              patch: { env: { WEB_PORT: "${{ ports.web }}", API_PORT: "${{ ports.api }}" } },
            },
            {
              path: "ports.txt",
              source: { kind: "content", content: { command: command("portsContent") } },
            },
          ],
          runFilesInputs: ["E2E_HOST"],
          setup: [{ name: "infrastructure", ...command("devSetup") }],
          servers: [
            ...["docker", "cache", "legacy"].map((name) => ({
              kind: "command" as const,
              name,
              start: command(`start:${name}`),
              stop: command(`stop:${name}`),
            })),
            {
              kind: "spawn",
              name: "ready",
              exec: { run: [cliExecutable, "scripts/ready-server.mjs"] },
              ready: { log: "FIXTURE_READY" },
            },
          ],
        },
  };
}

function lifecycleSource(): string {
  return `import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const ctx = JSON.parse(process.env.ALIGNFIRST_CONTEXT);
const action = process.argv[2];
async function barrier(name) {
  const file = process.env[name];
  if (file === undefined) return;
  writeFileSync(file + ".owner", String(process.ppid));
  writeFileSync(file + ".entered", String(process.pid));
  const deadline = Date.now() + 30000;
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error("fixture barrier timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
if (action === "finalize") {
  appendFileSync(join(ctx.mainWorktree, "finalize-pids.jsonl"), JSON.stringify(process.pid) + "\\n");
  await barrier("E2E_FINALIZE_BARRIER");
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.E2E_FINALIZE_DELAY_MS ?? 0)));
  if (process.env.E2E_FINALIZE_FAIL === "1") throw new Error("e2e boom");
  writeFileSync(join(ctx.currentWorktree, "finalized.txt"), "finalized\\n");
  const { name, currentWorktree, mainWorktree, isMainWorktree, branch } = ctx;
  writeFileSync(join(ctx.currentWorktree, "finalize-context.json"), JSON.stringify({ name, currentWorktree, mainWorktree, isMainWorktree, branch }));
} else if (action === "workspacePatch") {
  const input = readFileSync(0, "utf8");
  process.stdout.write(input.trim().split("\\n").filter((line) => !line.startsWith("worktree=")).concat("worktree=" + (ctx.isMainWorktree ? "main" : "linked")).join("\\n") + "\\n");
} else if (action === "seedCheck") {
  if (process.env.E2E_SEED_FAIL === "1") throw new Error("missing.template");
  process.stdout.write(readFileSync(0, "utf8"));
} else if (action === "portsContent") {
  process.stdout.write("web=" + (process.env.E2E_HOST ?? "localhost") + ":" + ctx.ports.web + "\\n");
} else if (action === "devSetup") {
  await barrier("E2E_DEV_SETUP_BARRIER");
  if (process.env.E2E_DEV_EXIT === "1") process.exit(3);
  if (process.env.E2E_DEV_SETUP_FAIL === "1") throw new Error("e2e dev boom.");
  appendFileSync(join(ctx.currentWorktree, "setup-runs.log"), "force=" + ctx.force + "\\n");
} else if (action === "purge") {
  appendFileSync(join(ctx.mainWorktree, "purge-runs.jsonl"), JSON.stringify({ name: ctx.name, worktree: ctx.currentWorktree, mainWorktree: ctx.mainWorktree, verbose: ctx.verbose }) + "\\n");
  if (process.env.E2E_PURGE_FAIL === "1") throw new Error("e2e purge boom");
  if (process.env.E2E_PURGE_RECREATE_WORKTREE === "1") mkdirSync(ctx.currentWorktree, { recursive: true });
} else {
  const [event, label] = action.split(":");
  if (process.env.E2E_CALLBACK_LIFECYCLE !== "1" && process.env.E2E_CALLBACK_RECORD !== "1") process.exit(0);
  const legacy = label === "legacy";
  appendFileSync(join(ctx.mainWorktree, "callback-runs.jsonl"), JSON.stringify({ event: legacy ? (event === "start" ? "legacyStart" : "legacyStop") : event, name: ctx.name, cwd: ctx.currentWorktree, ports: ctx.ports, ...(legacy ? {} : { label }) }) + "\\n");
  if (event === "start" && process.env.E2E_CALLBACK_START_FAIL === label) throw new Error("e2e callback start boom");
  if (event === "stop" && process.env.E2E_CALLBACK_STOP_FAIL === "1") throw new Error("e2e callback stop boom");
}
`;
}

function readyServerSource(): string {
  return `import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim();
appendFileSync(join(dirname(common), "spawn-runs.jsonl"), JSON.stringify({ pid: process.pid, cwd: process.cwd() }) + "\\n");
const deadline = Date.now() + 30000;
while (process.env.E2E_READY_BARRIER !== undefined && !existsSync(process.env.E2E_READY_BARRIER)) {
  if (Date.now() > deadline) throw new Error("e2e readiness barrier timed out");
  await new Promise((resolve) => setTimeout(resolve, 25));
}
if (process.env.E2E_RESIST_TERM === "1") process.on("SIGTERM", () => {});
console.log("FIXTURE_READY");
setInterval(() => {}, 1000);
`;
}

function git(repo: string, args: string[]): void {
  execFileSync("git", args, { cwd: repo, stdio: "pipe" });
}

export function runCli(
  repo: string,
  args: string[],
  env?: Record<string, string>,
  cwd = repo,
): SpawnSyncReturns<string> {
  return run(repo, "workspace", args, env, cwd);
}

export function runDev(
  worktree: string,
  args: string[],
  env?: Record<string, string>,
  cwd = worktree,
): SpawnSyncReturns<string> {
  return run(worktree, "dev", args, env, cwd);
}

function run(
  repo: string,
  command: string,
  args: string[],
  env: Record<string, string> | undefined,
  cwd: string,
): SpawnSyncReturns<string> {
  const main = dirname(
    execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: repo,
      encoding: "utf8",
    }).trim(),
  );
  return spawnSync(cliExecutable, [alignfirstBin, command, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, HOME: join(dirname(main), "home"), ...env },
    stdio: "pipe",
    timeout: 60000,
  });
}

export function readWorkspaces(repo: string): WorkspacesRegistry {
  return JSON.parse(readFileSync(registryPath(repo), "utf8"));
}

export function writeWorkspaces(repo: string, registry: WorkspacesRegistry): void {
  writeFileSync(registryPath(repo), JSON.stringify(registry, undefined, 2));
}

function registryPath(repo: string): string {
  return join(repo, ".local-wt", "workspace-registry", "workspaces.json");
}
