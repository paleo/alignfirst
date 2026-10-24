import { execFileSync, spawn, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

import { CliError } from "./cli-error.js";
import type { Streams } from "./context.js";

// Stalled transports give up on their own: SSH through the default command below, HTTPS through
// these options. A configured SSH command keeps its own timeouts.
const HTTP_STALL_OPTIONS = ["-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=30"];
const DEFAULT_SSH_COMMAND =
  "ssh -o BatchMode=yes -o ConnectTimeout=30 -o ServerAliveInterval=15 -o ServerAliveCountMax=3";

export function git(streams: Streams, dir: string, ...args: string[]): Promise<void> {
  return spawnGit(streams, dir, args);
}

export function gitNetwork(streams: Streams, dir: string, args: string[]): Promise<void> {
  return spawnGit(streams, dir, [...HTTP_STALL_OPTIONS, ...args]);
}

async function spawnGit(streams: Streams, dir: string, args: string[]): Promise<void> {
  const code = await spawnGitWithStreams(streams, dir, args);
  if (code !== 0) throw gitFailure(args);
}

export async function gitQuiet(dir: string, args: string[]): Promise<string | undefined> {
  let stderr = "";
  const code = await spawnGitWithStreams(
    {
      stdout: { write() {} },
      stderr: {
        write: (text) => {
          stderr += text;
        },
      },
    },
    dir,
    args,
  );
  if (code !== 0) return stderr.trim();
}

function spawnGitWithStreams(
  streams: Streams,
  dir: string,
  args: string[],
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", dir, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: nonInteractiveEnv(dir),
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (text: string) => streams.stdout.write(text));
    child.stderr.on("data", (text: string) => streams.stderr.write(text));
    child.once("error", (error) => reject(gitFailure(args, error.message)));
    child.once("close", resolve);
  });
}

export function nonInteractiveEnv(dir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true" };
  if (
    env.GIT_SSH_COMMAND === undefined &&
    env.GIT_SSH === undefined &&
    gitOutputOrUndefined(dir, "config", "--get", "core.sshCommand") === undefined
  )
    env.GIT_SSH_COMMAND = DEFAULT_SSH_COMMAND;
  return env;
}

function gitFailure(args: string[], detail?: string): CliError {
  const output = detail?.trim();
  const subcommand = gitSubcommand(args);
  const label = subcommand === undefined ? "git command" : `git ${subcommand}`;
  if (output === undefined || output === "")
    return new CliError(`${label} failed. See the git output above.`);
  return new CliError(`${label} failed:\n${output}`);
}

function gitSubcommand(args: string[]): string | undefined {
  let index = 0;
  while (args[index] === "-c") index += 2;
  return args[index];
}

export function assertMainWorktreeRoot(cwd: string): void {
  const toplevel = gitOutput(cwd, "rev-parse", "--show-toplevel");
  if (realpathSync(toplevel) !== realpathSync(cwd))
    throw new CliError("Run this command from the repository root.");
  const gitDir = gitOutput(cwd, "rev-parse", "--absolute-git-dir");
  const commonDir = gitOutput(cwd, "rev-parse", "--git-common-dir");
  if (realpathSync(gitDir) !== realpathSync(resolve(cwd, commonDir)))
    throw new CliError(
      "Run this command from the main worktree. Linked worktrees reach .plans through it.",
    );
}

export function linkedMainWorktree(cwd: string): string | undefined {
  const mainWorktree = findMainWorktree(cwd);
  if (mainWorktree === undefined) return;
  const root = gitOutput(cwd, "rev-parse", "--show-toplevel");
  if (realpathSync(root) === mainWorktree) return;
  return mainWorktree;
}

/** The main worktree is the parent of the common `.git` directory; a bare repository has none. */
export function findMainWorktree(cwd: string): string | undefined {
  const identity = optionalRepositoryId(cwd);
  if (identity === undefined || basename(identity) !== ".git") return;
  return realpathSync(dirname(identity));
}

export function optionalRepositoryId(dir: string): string | undefined {
  const args = ["rev-parse", "--path-format=absolute", "--git-common-dir"];
  const result = spawnSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    // Git has no distinct exit status for discovery failure versus a non-repository.
    env: { ...process.env, LC_ALL: "C" },
  });
  if (result.error !== undefined) throw gitFailure(args, result.error.message);
  if (result.status !== 0) {
    if (result.stderr.startsWith("fatal: not a git repository (or any ")) return;
    throw gitFailure(args, result.stderr);
  }
  return realpathSync(result.stdout.trim());
}

export function gitOutput(dir: string, ...args: string[]): string {
  return gitOutputRaw(dir, ...args).trim();
}

export function gitOutputRaw(dir: string, ...args: string[]): string {
  const output = gitBuffer(dir, ...args);
  const text = output.toString("utf8");
  if (!Buffer.from(text).equals(output))
    throw new CliError("Cannot read non-UTF-8 Git output safely. Resolve the rebase manually.");
  return text;
}

export function gitBuffer(dir: string, ...args: string[]): Buffer {
  const result = spawnSync("git", ["-C", dir, ...args]);
  if (result.error !== undefined) throw gitFailure(args, result.error.message);
  if (result.status !== 0) throw gitFailure(args, result.stderr.toString("utf8"));
  return result.stdout;
}

export function gitOutputOrUndefined(dir: string, ...args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return;
  }
}

export function gitSucceeds(dir: string, ...args: string[]): boolean {
  try {
    execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
