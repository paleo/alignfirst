import type * as ChildProcess from "node:child_process";
import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  gitNetwork,
  gitQuiet,
  nonInteractiveEnv,
  optionalRepositoryId,
  git as runGit,
} from "../src/git.js";
import { configureGit, git, makeSink, makeTempDir, runMain } from "./helpers.js";

const dirs: string[] = [];

vi.mock("node:child_process", async (original) => {
  const childProcess = await original<typeof ChildProcess>();
  return { ...childProcess, spawn: vi.fn(childProcess.spawn) };
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("git failures", () => {
  it("propagates a missing Git executable instead of treating the directory as outside Git", () => {
    const dir = makeFixture();
    vi.stubEnv("PATH", dir);
    expect(() => optionalRepositoryId(dir)).toThrow("ENOENT");
  });

  it("propagates an invalid explicit Git directory instead of treating it as discovery absence", () => {
    const dir = makeFixture();
    vi.stubEnv("GIT_DIR", join(dir, "missing"));
    expect(() => optionalRepositoryId(dir)).toThrow("not a git repository:");
  });

  it("carries git's own message when nothing was printed", async () => {
    const dir = makeFixture();
    const result = await runMain(["plans", "setup", "clone", "--folder", "product"], { cwd: dir });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("git rev-parse failed:");
    expect(result.stderr).toContain("not a git repository");
  });

  it("writes git output to the streams and names the subcommand past global options", async () => {
    const dir = makeFixture();
    git(dir, "init", "--quiet");
    const stdout = makeSink();
    const stderr = makeSink();
    await expect(
      runGit({ stdout, stderr }, dir, "-c", "core.editor=true", "rebase", "--continue"),
    ).rejects.toThrow("git rebase failed. See the git output above.");
    // Git 2.39 prints "No rebase in progress?".
    expect(stderr.text()).toMatch(/no rebase in progress/i);
  });

  it("captures quiet failures and streams neither successful nor failed output", async () => {
    const dir = makeFixture();
    git(dir, "init", "--quiet");
    git(dir, "commit", "--quiet", "--allow-empty", "-m", "base");
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      await expect(gitQuiet(dir, ["log", "--oneline"])).resolves.toBeUndefined();
      const failure = await gitQuiet(dir, ["rebase", "--continue"]);
      expect(failure).toMatch(/no rebase in progress/i);
      expect(failure).toBe(failure?.trim());
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

  it("rejects a quiet spawn error", async () => {
    const dir = makeFixture();
    vi.stubEnv("PATH", dir);
    await expect(gitQuiet(dir, ["status"])).rejects.toThrow(/git status failed:\n.*ENOENT/);
  });

  it("streams output beyond the synchronous child-process buffer limit", async () => {
    const dir = makeFixture();
    git(dir, "init", "--quiet");
    const contents = "x".repeat(2 * 1024 * 1024);
    writeFileSync(join(dir, "large.txt"), contents);
    git(dir, "add", "large.txt");
    git(dir, "commit", "--quiet", "-m", "large output");
    const stdout = makeSink();
    const stderr = makeSink();
    await runGit({ stdout, stderr }, dir, "show", "HEAD:large.txt");
    expect(stdout.text()).toBe(contents);
    expect(stderr.text()).toBe("");
  });
});

describe("non-interactive Git", () => {
  it("disables prompts and supplies a batch-mode SSH default", () => {
    const dir = makeFixture();
    git(dir, "init", "--quiet");
    vi.stubEnv("GIT_SSH_COMMAND", undefined);
    vi.stubEnv("GIT_SSH", undefined);
    expect(nonInteractiveEnv(dir)).toMatchObject({
      GIT_TERMINAL_PROMPT: "0",
      GIT_EDITOR: "true",
      GIT_SSH_COMMAND:
        "ssh -o BatchMode=yes -o ConnectTimeout=30 -o ServerAliveInterval=15 -o ServerAliveCountMax=3",
    });
  });

  it.each(["GIT_SSH_COMMAND", "GIT_SSH"])("preserves %s", (key) => {
    const dir = makeFixture();
    vi.stubEnv("GIT_SSH_COMMAND", undefined);
    vi.stubEnv("GIT_SSH", undefined);
    vi.stubEnv(key, "custom-ssh");
    expect(nonInteractiveEnv(dir)[key]).toBe("custom-ssh");
    if (key === "GIT_SSH") expect(nonInteractiveEnv(dir).GIT_SSH_COMMAND).toBeUndefined();
  });

  it("preserves core.sshCommand", () => {
    const dir = makeFixture();
    git(dir, "init", "--quiet");
    git(dir, "config", "core.sshCommand", "configured-ssh");
    vi.stubEnv("GIT_SSH_COMMAND", undefined);
    vi.stubEnv("GIT_SSH", undefined);
    expect(nonInteractiveEnv(dir).GIT_SSH_COMMAND).toBeUndefined();
  });

  it("lets HTTPS transfers give up on a stall", async () => {
    const dir = makeFixture();
    git(dir, "init", "--quiet");
    git(dir, "commit", "--quiet", "--allow-empty", "-m", "base");
    const stderr = makeSink();
    await gitNetwork({ stdout: makeSink(), stderr }, dir, ["fetch", "--quiet", dir]);
    expect(stderr.text()).toBe("");
    expect(vi.mocked(spawn).mock.lastCall?.[1]).toEqual([
      "-C",
      dir,
      "-c",
      "http.lowSpeedLimit=1000",
      "-c",
      "http.lowSpeedTime=30",
      "fetch",
      "--quiet",
      dir,
    ]);
  });
});

function makeFixture(): string {
  const dir = makeTempDir("alignfirst-git-");
  dirs.push(dir);
  configureGit(dir);
  return dir;
}
