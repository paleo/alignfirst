import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { configureGit, git, makeTempDir, runMain } from "./helpers.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("conventions command", () => {
  it("renders configured conventions, local plans, and ignored searches", async () => {
    const cwd = makeProject();
    mkdirSync(join(cwd, ".plans"));
    mkdirSync(join(cwd, ".local"));
    mkdirSync(join(cwd, ".local-wt"));
    writeFileSync(join(cwd, ".gitignore"), ".plans\n.local\n.local-wt\n");
    writeFileSync(
      join(cwd, ".alignfirst.json"),
      JSON.stringify({
        schemaVersion: 1,
        ticketIdPattern: "^\\d+$",
        plans: { autoArchive: true },
        git: {
          defaultBranch: "main",
          branchNameTemplate: "{ticketId}/{slug-1-3-words}",
          commit: { style: "conventionalCommit", ticketReference: "bracketedHash" },
          agentCoauthoring: false,
        },
      }),
    );
    const result = await runMain(["conventions"], { cwd });
    expect(result.stdout).toBe(
      "Ticket IDs: `^\\d+$`; infer a matching ID from the branch. Without an external ticket, use the next `side-N`.\n" +
        "Branch names: `{ticketId}/{slug-1-3-words}`.\n" +
        "Commits: `type: [#ticketId] summary`; use `type: summary` for `side-N`. Do not add an agent co-author trailer.\n" +
        "Default branch: main.\n" +
        "Plans: use `.plans`; keep it out of product commits. Automatic archival is enabled.\n" +
        "Searches: exclude `.plans`, `.local` and `.local-wt` from broad codebase searches.\n",
    );
  });

  it("renders cached and unresolved default branches and omits absent plans", async () => {
    const cwd = makeProject();
    expect((await runMain(["conventions"], { cwd })).stdout).toContain(
      "Default branch: unresolved; ask before default-branch operations.",
    );
    expect((await runMain(["conventions"], { cwd })).stdout).not.toContain("Plans:");

    const remote = join(cwd, "remote.git");
    git(cwd, "init", "--quiet", "--bare", remote);
    git(cwd, "remote", "add", "origin", remote);
    git(cwd, "push", "-q", "-u", "origin", "main");
    git(cwd, "remote", "set-head", "origin", "main");
    expect((await runMain(["conventions"], { cwd })).stdout).toContain(
      "Default branch: main (cached).",
    );
  });

  it("does not list an ignored directory that contains tracked files", async () => {
    const cwd = makeProject();
    mkdirSync(join(cwd, ".local"));
    writeFileSync(join(cwd, ".local", "file"), "tracked\n");
    git(cwd, "add", "-f", ".local/file");
    git(cwd, "commit", "--quiet", "-m", "track local");
    writeFileSync(join(cwd, ".gitignore"), ".local\n");
    expect((await runMain(["conventions"], { cwd })).stdout).not.toContain("Searches:");
  });
});

function makeProject(): string {
  const cwd = makeTempDir("alignfirst-conventions-");
  dirs.push(cwd);
  configureGit(cwd);
  git(cwd, "init", "--quiet");
  writeFileSync(join(cwd, "README.md"), "project\n");
  git(cwd, "add", "-A");
  git(cwd, "commit", "--quiet", "-m", "init");
  return cwd;
}
