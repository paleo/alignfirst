import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { SlotsRegistry } from "../../src/slots.js";

/** Repo root of `@paleo/workspace`, resolved from this file's location. */
export const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

// The fixture's `workspace.mjs` is a plain `node` subprocess, so it imports the *built* package.
const distIndexUrl = pathToFileURL(join(packageRoot, "dist", "index.js")).href;

export interface FixtureRepo {
  /** The `mkdtemp` root; delete it to clean up. */
  root: string;
  /** The git repo, at `<root>/fixrepo`; worktrees land at `<root>/fixrepo-<branch>`. */
  repo: string;
}

export function createFixtureRepo(): FixtureRepo {
  const root = mkdtempSync(join(tmpdir(), "workspace-e2e-"));
  const repo = join(root, "fixrepo");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  writeFileSync(join(repo, "scripts", "workspace.mjs"), workspaceMjsSource());
  writeFileSync(
    join(repo, "scripts", "dev-server.mjs"),
    "// stub: only its existence is required\n",
  );
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "e2e@example.com"]);
  git(repo, ["config", "user.name", "E2E"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "init"]);
  return { root, repo };
}

function workspaceMjsSource(): string {
  return `import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runWorkspace } from "${distIndexUrl}";

await runWorkspace({
  scriptPath: fileURLToPath(import.meta.url),
  devServerScript: fileURLToPath(new URL("./dev-server.mjs", import.meta.url)),
  basePort: 8100,
  portNames: ["web"],
  sharedDirs: [],
  configFiles: [],
  runtimeDir: ".wt",
  printSummary: () => "Workspace ready.",
  finalizeWorktree: (ctx) => {
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

export function readSlots(repo: string): SlotsRegistry {
  const path = join(repo, ".wt", "workspace-registry", "slots.json");
  return JSON.parse(readFileSync(path, "utf-8")) as SlotsRegistry;
}

function git(repo: string, args: string[]): void {
  execFileSync("git", args, { cwd: repo, stdio: "pipe" });
}
