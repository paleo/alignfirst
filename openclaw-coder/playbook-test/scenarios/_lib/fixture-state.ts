import { execFileSync } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import type { ScenarioContext } from "@paleo/openclaw-test";

const PROJECTS_DIR = "/home/claw/projects";

/**
 * Worktree directory the `@paleo/workspace` library produces for a ticket
 * branch on the given fixture project. Branch shape is `<ticket>/<desc>`; the
 * library's default `defaultWorktreeDirName` joins segments with `-`.
 */
export function worktreePath(project: string, ticket: string, desc: string): string {
  return `${PROJECTS_DIR}/${project}-${ticket}-${desc}`;
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
  desc: string,
  { timeoutMs }: WaitForWorktreeDirOptions,
): Promise<string> {
  const target = worktreePath(project, ticket, desc);
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
  desc: string;
}

/**
 * Like `waitForWorktreeDir`, but description-agnostic: polls for any worktree
 * `<project>-<ticket>-<desc>` and returns the actual `<desc>` the agent chose.
 * The branch suffix is a short free-form description (`{TICKET_ID}/{1-3-words}`),
 * so the scenario must not pin it — only that a worktree for the ticket appears.
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
    if (match)
      return { dir: `${PROJECTS_DIR}/${match.name}`, desc: match.name.slice(prefix.length) };
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no worktree dir ${prefix}<desc> appeared within ${timeoutMs}ms`);
}

export function assertBranch(worktreeDir: string, expectedBranch: string): void {
  const actual = readWorktreeBranch(worktreeDir);
  if (actual !== expectedBranch) {
    throw new Error(
      `branch mismatch in ${worktreeDir}: expected "${expectedBranch}", got "${actual}"`,
    );
  }
}

/**
 * Asserts the worktree is on a `<ticket>/<desc>` branch for the given ticket and
 * returns the actual branch. Unlike `assertBranch`, it does not pin the
 * description: the agent derives it (`{TICKET_ID}/{1-3-words}`), and the worktree
 * DIRECTORY name is capped at 22 chars by `@paleo/workspace`'s
 * `defaultWorktreeDirName`, so the dir name cannot be used to reconstruct the
 * branch. Git is the source of truth.
 */
export function assertBranchForTicket(worktreeDir: string, ticket: string): string {
  const actual = readWorktreeBranch(worktreeDir);
  if (!new RegExp(`^${escapeRegExp(ticket)}/.+`).test(actual)) {
    throw new Error(
      `branch mismatch in ${worktreeDir}: expected "${ticket}/<desc>", got "${actual}"`,
    );
  }
  return actual;
}

function readWorktreeBranch(worktreeDir: string): string {
  return execFileSync("git", ["-C", worktreeDir, "rev-parse", "--abbrev-ref", "HEAD"], {
    encoding: "utf8",
  }).trim();
}

/** Escapes a dynamic value for safe interpolation into a `RegExp` source. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
 * registered workspace. Runs the real `pnpm workspace setup … -c` in the
 * gateway (setup blocks until READY/FAILED). Waits until the worktree
 * directory appears.
 */
export async function seedWorktree(
  ctx: ScenarioContext,
  project: string,
  ticket: string,
  desc: string,
): Promise<string> {
  const branch = `${ticket}/${desc}`;
  const exec = await ctx.execInGateway(
    ["sh", "-c", `cd ${PROJECTS_DIR}/${project} && pnpm workspace setup ${branch} -c`],
    { timeoutMs: 120_000 },
  );
  if (exec.exitCode !== 0) {
    throw new Error(
      `seedWorktree: pnpm workspace setup ${branch} -c failed (exit ${exec.exitCode}).\n` +
        `stdout:\n${exec.stdout}\nstderr:\n${exec.stderr}`,
    );
  }
  return waitForWorktreeDir(project, ticket, desc, { timeoutMs: 30_000 });
}

/**
 * Pre-seed a branch (no worktree). Runs `git branch <ticket>/<desc> main`
 * in the project's main worktree.
 */
export async function seedBranch(
  ctx: ScenarioContext,
  project: string,
  ticket: string,
  desc: string,
): Promise<void> {
  const branch = `${ticket}/${desc}`;
  const exec = await ctx.execInGateway(
    ["git", "-C", `${PROJECTS_DIR}/${project}`, "branch", branch, "main"],
    { timeoutMs: 15_000 },
  );
  if (exec.exitCode !== 0) {
    throw new Error(
      `seedBranch: git branch ${branch} failed (exit ${exec.exitCode}).\n` +
        `stdout:\n${exec.stdout}\nstderr:\n${exec.stderr}`,
    );
  }
}
