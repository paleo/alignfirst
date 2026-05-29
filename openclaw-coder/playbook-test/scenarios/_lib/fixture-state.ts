import { execFileSync } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import type { ScenarioContext } from "@paleo/openclaw-test";

const PROJECTS_DIR = "/home/claw/projects";

/**
 * Worktree directory the `@paleo/workspace` library produces for a ticket
 * branch on the given fixture project. Branch shape is `<ticket>/<type>`; the
 * library's default `defaultWorktreeDirName` joins segments with `-`.
 */
export function worktreePath(project: string, ticket: string, type: string): string {
  return `${PROJECTS_DIR}/${project}-${ticket}-${type}`;
}

export interface WaitForWorktreeDirOptions {
  timeoutMs: number;
}

/**
 * Polls the shared `/home/claw/projects/` volume until the expected worktree
 * directory exists.
 */
export async function waitForWorktreeDir(
  project: string,
  ticket: string,
  type: string,
  { timeoutMs }: WaitForWorktreeDirOptions,
): Promise<string> {
  const target = worktreePath(project, ticket, type);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const s = await stat(target);
      if (s.isDirectory()) return target;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`worktree dir ${target} did not appear within ${timeoutMs}ms`);
}

export interface WorktreeMatch {
  dir: string;
  type: string;
}

/**
 * Like `waitForWorktreeDir`, but work-type-agnostic: polls for any worktree
 * `<project>-<ticket>-<type>` and returns the actual `<type>` the agent chose.
 * "Make the export button bold" is legitimately a `feat` or a `fix`, so the
 * scenario must not pin the type — only that a worktree for the ticket appears.
 */
export async function waitForAnyWorktreeDir(
  project: string,
  ticket: string,
  { timeoutMs }: WaitForWorktreeDirOptions,
): Promise<WorktreeMatch> {
  const prefix = `${project}-${ticket}-`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entries = await readdir(PROJECTS_DIR, { withFileTypes: true }).catch(() => []);
    const match = entries.find((e) => e.isDirectory() && e.name.startsWith(prefix));
    if (match) return { dir: `${PROJECTS_DIR}/${match.name}`, type: match.name.slice(prefix.length) };
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no worktree dir ${prefix}<type> appeared within ${timeoutMs}ms`);
}

export function assertBranch(worktreeDir: string, expectedBranch: string): void {
  const actual = execFileSync("git", ["-C", worktreeDir, "rev-parse", "--abbrev-ref", "HEAD"], {
    encoding: "utf8",
  }).trim();
  if (actual !== expectedBranch) {
    throw new Error(
      `branch mismatch in ${worktreeDir}: expected "${expectedBranch}", got "${actual}"`,
    );
  }
}

/**
 * Fetches the dev-server HTTP response body from the **runner** side. The
 * dev-server process runs in the gateway PID namespace, so its port is
 * reachable at `gateway:<slotPort>` via the compose network.
 */
export async function fetchDevServer(slotPort: number): Promise<string> {
  const res = await fetch(`http://gateway:${slotPort}/`);
  return res.text();
}

/**
 * Pre-seed a branch + worktree for `project` so the agent finds an existing
 * registered workspace. Runs the real `pnpm workspace setup … -c --wait`
 * in the gateway. Waits until the worktree directory appears.
 */
export async function seedWorktree(
  ctx: ScenarioContext,
  project: string,
  ticket: string,
  type: string,
): Promise<string> {
  const branch = `${ticket}/${type}`;
  const exec = await ctx.execInGateway(
    ["sh", "-c", `cd ${PROJECTS_DIR}/${project} && pnpm workspace setup ${branch} -c --wait`],
    { timeoutMs: 120_000 },
  );
  if (exec.exitCode !== 0) {
    throw new Error(
      `seedWorktree: pnpm workspace setup ${branch} -c failed (exit ${exec.exitCode}).\n` +
        `stdout:\n${exec.stdout}\nstderr:\n${exec.stderr}`,
    );
  }
  return waitForWorktreeDir(project, ticket, type, { timeoutMs: 30_000 });
}

/**
 * Pre-seed a branch (no worktree). Runs `git branch <ticket>/<type> develop`
 * in the project's main worktree.
 */
export async function seedBranch(
  ctx: ScenarioContext,
  project: string,
  ticket: string,
  type: string,
): Promise<void> {
  const branch = `${ticket}/${type}`;
  const exec = await ctx.execInGateway(
    ["git", "-C", `${PROJECTS_DIR}/${project}`, "branch", branch, "develop"],
    { timeoutMs: 15_000 },
  );
  if (exec.exitCode !== 0) {
    throw new Error(
      `seedBranch: git branch ${branch} failed (exit ${exec.exitCode}).\n` +
        `stdout:\n${exec.stdout}\nstderr:\n${exec.stderr}`,
    );
  }
}
