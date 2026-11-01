import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { WorkspaceManifest, Command } from "../../src/workspace-config-types.js";
import type { WorkspacesRegistry } from "../../src/workspaces.js";
import type { DevServerEntry } from "../../src/dev-servers-registry.js";
import type { StartupOwners } from "../../src/startup-registry.js";

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
const fixtures = new Set<FixtureRepo>();

export interface FixtureRepo {
  root: string;
  repo: string;
  devActivityAttempted: boolean;
}

export interface FixtureOptions {
  portless?: boolean;
  fallbackSeeding?: boolean;
  oldConfig?: boolean;
  sharedDirs?: string[];
  companionRuntime?: boolean;
  companionRecipe?: boolean;
}

/** Disposable Git, home and project-owned scripts. No consumer wrapper or local dependencies. */
export function createFixtureRepo(
  options: FixtureOptions = {},
  register?: (fixture: FixtureRepo) => void,
): FixtureRepo {
  const root = mkdtempSync(join(tmpdir(), "workspace-e2e-"));
  const repo = join(root, "fixrepo");
  const fixture = { root, repo, devActivityAttempted: false };
  fixtures.add(fixture);
  register?.(fixture);
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
    `${["/.plans", "/.local", "/.local-wt/", ...(options.sharedDirs ?? []).map((dir) => `/${dir}`), "workspace.local", "required.local", "ports.env", "ports.txt", "setup-runs.log", "finalized.txt", "finalize-context.json", "*-runs.jsonl", "finalize-pids.jsonl", "finalize-owners.jsonl"].join("\n")}\n`,
  );
  writeFileSync(
    join(repo, "alignfirst.json"),
    JSON.stringify({ schemaVersion: 1, ...manifest, ...(options.oldConfig ? { ports: {} } : {}) }),
  );
  if (options.companionRuntime || options.companionRecipe) {
    const companion = join(root, "companion");
    mkdirSync(join(companion, ".plans"), { recursive: true });
    const registry = join(root, "home/.alignfirst/companions");
    mkdirSync(registry, { recursive: true });
    writeFileSync(
      join(registry, "registry.json"),
      JSON.stringify({
        projects: {
          [repo]: {
            dir: companion,
            defaultLocation: "companion",
            items: {
              alignfirst: options.companionRecipe ? "companion" : "project",
              workspaceRuntime: options.companionRuntime ? "companion" : "project",
            },
          },
        },
      }),
    );
    if (options.companionRecipe)
      writeFileSync(
        join(companion, "alignfirst.json"),
        readFileSync(join(repo, "alignfirst.json")),
      );
  }
  git(repo, ["init", "-b", "main"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "init"]);
  return fixture;
}

function fixtureManifest(options: FixtureOptions): WorkspaceManifest {
  const command = (phase: string): Command => ({
    run: [cliExecutable, "scripts/lifecycle.mjs", phase],
  });
  return {
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
  return `import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const ctx = JSON.parse(process.env.ALIGNFIRST_WORKSPACE_CONTEXT);
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
if (action === "finalize" || action === "trackFinalizer") {
  appendFileSync(join(ctx.mainWorktree, "finalize-pids.jsonl"), JSON.stringify(process.pid) + "\\n");
  appendFileSync(join(ctx.mainWorktree, "finalize-owners.jsonl"), JSON.stringify(process.ppid) + "\\n");
}
if (action === "trackFinalizer") process.exit(0);
if (action === "finalize") {
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
  if (process.env.E2E_SETUP_GRANDCHILD_FILE !== undefined) {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    writeFileSync(process.env.E2E_SETUP_GRANDCHILD_FILE, String(child.pid));
  }
  await barrier("E2E_DEV_SETUP_BARRIER");
  if (process.env.E2E_DEV_EXIT === "1") process.exit(3);
  if (process.env.E2E_DEV_SETUP_FAIL === "1") throw new Error("e2e dev boom.");
  appendFileSync(join(ctx.currentWorktree, "setup-runs.log"), "force=" + ctx.force + "\\n");
} else if (action === "purge") {
  appendFileSync(join(ctx.mainWorktree, "purge-runs.jsonl"), JSON.stringify({ name: ctx.name, worktree: ctx.currentWorktree, mainWorktree: ctx.mainWorktree, runtimeDir: ctx.runtimeDir, verbose: ctx.verbose }) + "\\n");
  if (process.env.E2E_PURGE_FAIL === "1") throw new Error("e2e purge boom");
  if (process.env.E2E_PURGE_RECREATE_WORKTREE === "1") mkdirSync(ctx.currentWorktree, { recursive: true });
  if (process.env.E2E_PURGE_LOCK_WORKTREE === "1") execFileSync("git", ["worktree", "lock", ctx.currentWorktree], { cwd: ctx.mainWorktree });
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

export function installResourceRecipe(
  worktree: string,
  version: string,
  options: { service?: boolean } = {},
): void {
  ownedFixture(worktree).devActivityAttempted = true;
  const file = join(worktree, "alignfirst.json");
  const manifest: WorkspaceManifest = JSON.parse(readFileSync(file, "utf8"));
  const command = (action: string): Command => ({
    run: [cliExecutable, "scripts/resource.mjs", action],
    env: { E2E_RECIPE_VERSION: version },
  });
  if (options.service !== false)
    manifest.devServer?.servers.push({
      kind: "command",
      name: "extra",
      start: command("start"),
      stop: command("stop"),
    });
  manifest.workspace ??= {};
  manifest.workspace.purge = [{ name: "resource", ...command("purge") }];
  writeFileSync(file, JSON.stringify(manifest));
  writeFileSync(
    join(worktree, "scripts", "resource.mjs"),
    `import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const ctx = JSON.parse(process.env.ALIGNFIRST_WORKSPACE_CONTEXT);
const action = process.argv[2];
const version = ${JSON.stringify(version)};
const resources = join(dirname(ctx.mainWorktree), "resources");
mkdirSync(resources, { recursive: true });
const marker = join(resources, ctx.name);
appendFileSync(join(ctx.mainWorktree, "resource-runs.jsonl"), JSON.stringify({ action, version, recipeVersion: process.env.E2E_RECIPE_VERSION, cwd: process.cwd(), ctx }) + "\\n");
if (action === "start") writeFileSync(marker, version);
if (action === "stop" && process.env.E2E_RESOURCE_STOP_BARRIER !== undefined) {
  const barrier = process.env.E2E_RESOURCE_STOP_BARRIER;
  writeFileSync(barrier + ".entered", String(process.pid));
  while (!existsSync(barrier)) await new Promise((resolve) => setTimeout(resolve, 25));
}
if (process.env.E2E_RESOURCE_FAIL === action) throw new Error("resource " + action + " failed");
if (action === "stop" || action === "purge") rmSync(marker, { force: true });
`,
  );
}

export interface ResourceEvent {
  action: string;
  version: string;
  recipeVersion: string;
  cwd: string;
  ctx: {
    name: string;
    currentWorktree: string;
    mainWorktree: string;
    branch?: string;
    ports?: Record<string, number>;
    phase: string;
  };
}

export function resourceEvents(repo: string): ResourceEvent[] {
  const file = join(repo, "resource-runs.jsonl");
  return existsSync(file)
    ? readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];
}

function git(repo: string, args: string[]): void {
  execFileSync("git", ["-c", "user.name=E2E", "-c", "user.email=e2e@example.com", ...args], {
    cwd: repo,
    stdio: "pipe",
  });
}

export function runCli(
  target: FixtureRepo | string,
  args: string[],
  env?: Record<string, string>,
  cwd = typeof target === "string" ? target : target.repo,
): SpawnSyncReturns<string> {
  return run(ownedFixture(target), "workspace", args, env, cwd);
}

export function runDev(
  target: FixtureRepo | string,
  args: string[],
  env?: Record<string, string>,
  cwd = typeof target === "string" ? target : target.repo,
): SpawnSyncReturns<string> {
  return run(ownedFixture(target), "dev", args, env, cwd);
}

function ownedFixture(target: FixtureRepo | string): FixtureRepo {
  if (typeof target !== "string") return target;
  const fixture = [...fixtures].find((candidate) => {
    const path = relative(candidate.root, resolve(target));
    return path !== ".." && !path.startsWith(`..${sep}`);
  });
  if (!fixture) throw new Error(`Pass the owning fixture for external target ${target}`);
  return fixture;
}

function run(
  fixture: FixtureRepo,
  command: string,
  args: string[],
  env: Record<string, string> | undefined,
  cwd: string,
): SpawnSyncReturns<string> {
  recordDevActivity(fixture, command, args);
  return spawnSync(cliExecutable, [alignfirstBin, command, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, HOME: join(fixture.root, "home"), ...env },
    stdio: "pipe",
    timeout: 60000,
  });
}

export function recordDevActivity(fixture: FixtureRepo, command: string, args: string[]): void {
  if (
    (command === "workspace" && args[0] === "setup" && args.includes("--full")) ||
    (command === "dev" &&
      (args.length === 0 || ["setup", "up", "restart", "--restart", "--evict"].includes(args[0])))
  ) {
    fixture.devActivityAttempted = true;
  }
}

export async function cleanupFixture(
  fixture: FixtureRepo,
  env: Record<string, string> = {},
): Promise<void> {
  const failures: unknown[] = [];
  try {
    await joinFixtureFinalizers(fixture);
  } catch (error) {
    throw new Error(`Unsettled preparation; retained ${fixture.root}`, { cause: error });
  }
  // Inspect unpruned records before any CLI can discard all-dead command-service ownership.
  const before = fixtureDevEntries(fixture);
  const registry = join(fixtureRegistryDir(fixture.repo), "workspaces.json");
  const entries = existsSync(registry)
    ? Object.values(readWorkspaces(fixture.repo).workspaces)
    : [];
  const resources = join(fixture.root, "resources");
  const hasResources = () => existsSync(resources) && readdirSync(resources).length > 0;
  const targets = new Set(before.map((entry) => entry.worktree));
  for (const entry of entries) {
    if (fixture.devActivityAttempted || hasResources() || entry.cleanupPending)
      targets.add(entry.worktree);
  }
  const pids = new Set([
    ...before.flatMap((entry) => Object.values(entry.pids)),
    ...fixtureJsonLines<{ pid: number }>(join(fixture.repo, "spawn-runs.jsonl")).map(
      (event) => event.pid,
    ),
  ]);
  for (const target of targets) {
    try {
      const result = runCli(fixture, ["teardown", target], {
        E2E_CALLBACK_LIFECYCLE: "1",
        ...env,
      });
      if (result.error || result.status !== 0)
        throw new Error(`Cleanup ${target}: ${result.error?.message ?? result.stderr}`);
    } catch (error) {
      failures.push(error);
    }
  }
  for (const pid of pids) {
    try {
      await waitForFixtureExit(pid);
    } catch (error) {
      failures.push(error);
    }
  }
  if (fixtureDevEntries(fixture).length > 0 || hasResources())
    failures.push(new Error("Owned dev records or command resources remain"));
  const startups = join(fixtureRegistryDir(fixture.repo), "dev-startups.json");
  if (existsSync(startups)) {
    const pending: StartupOwners = JSON.parse(readFileSync(startups, "utf8"));
    if (pending.owners.length > 0) failures.push(new Error("Owned startup claims remain"));
  }
  if (existsSync(registry)) {
    const settled = readWorkspaces(fixture.repo);
    for (const entry of Object.values(settled.workspaces)) {
      if (
        entry.status === "pending" ||
        entry.preparationOwner ||
        entry.cleanupOwner ||
        entry.cleanupPending
      )
        failures.push(new Error(`Unsettled workspace ${entry.worktree}`));
    }
    for (const owner of Object.values(settled.runtimeOwners ?? {})) {
      if (owner.state === "deletionPending" || owner.deletionClaim)
        failures.push(new Error(`Unsettled runtime ${owner.runtimeDir}`));
    }
  }
  if (failures.length > 0)
    throw new AggregateError(failures, `Fixture cleanup failed; retained ${fixture.root}`);
  rmSync(fixture.root, { recursive: true, force: true });
  fixtures.delete(fixture);
}

export async function joinFixtureFinalizers(fixture: FixtureRepo): Promise<void> {
  const failures: unknown[] = [];
  const pendingOwners: number[] = [];
  const registry = join(fixtureRegistryDir(fixture.repo), "workspaces.json");
  if (existsSync(registry)) {
    for (const entry of Object.values(readWorkspaces(fixture.repo).workspaces)) {
      if (entry.status !== "pending" || entry.cleanupPending) continue;
      if (entry.preparationOwner) pendingOwners.push(entry.preparationOwner.pid);
      const result = runCli(fixture, ["wait", entry.worktree]);
      const settled = Object.values(readWorkspaces(fixture.repo).workspaces).find(
        (current) => current.worktree === entry.worktree,
      );
      // A finalized failure returns 1. A timeout, signal or still-pending record is unresolved.
      if (
        result.error ||
        (result.status !== 0 && result.status !== 1) ||
        settled?.status === "pending" ||
        settled?.preparationOwner
      )
        failures.push(
          new Error(`Preparation ${entry.worktree}: ${result.error?.message ?? result.stderr}`),
        );
    }
  }
  const pids = [...new Set([...pendingOwners, ...fixtureFinalizerPids(fixture)])];
  const joined = await Promise.allSettled(pids.map(waitForFixtureExit));
  for (const result of joined) {
    if (result.status === "rejected") failures.push(result.reason);
  }
  if (failures.length > 0) throw new AggregateError(failures, "Finalizer ownership did not settle");
}

function fixtureFinalizerPids(fixture: FixtureRepo): number[] {
  return [
    ...new Set([
      ...fixtureJsonLines<number>(join(fixture.repo, "finalize-owners.jsonl")),
      ...fixtureJsonLines<number>(join(fixture.repo, "finalize-pids.jsonl")),
    ]),
  ];
}

function fixtureDevEntries(fixture: FixtureRepo): DevServerEntry[] {
  const file = join(fixtureRegistryDir(fixture.repo), "dev-servers.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).servers : [];
}

function fixtureJsonLines<T>(file: string): T[] {
  return existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line))
    : [];
}

async function waitForFixtureExit(pid: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (fixturePidAlive(pid)) {
    if (Date.now() > deadline) throw new Error(`Owned fixture process ${pid} did not exit`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function fixturePidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

export function readWorkspaces(repo: string): WorkspacesRegistry {
  return JSON.parse(readFileSync(registryPath(repo), "utf8"));
}

export function writeWorkspaces(repo: string, registry: WorkspacesRegistry): void {
  writeFileSync(registryPath(repo), JSON.stringify(registry, undefined, 2));
}

export function fixtureRegistryDir(repo: string): string {
  return dirname(registryPath(repo));
}

function registryPath(repo: string): string {
  const selected = join(dirname(repo), "home/.alignfirst/companions/registry.json");
  const external =
    existsSync(selected) &&
    JSON.parse(readFileSync(selected, "utf8")).projects[repo]?.items.workspaceRuntime ===
      "companion";
  return join(
    external ? join(dirname(repo), "companion") : repo,
    ".local-wt",
    "workspace-registry",
    "workspaces.json",
  );
}
