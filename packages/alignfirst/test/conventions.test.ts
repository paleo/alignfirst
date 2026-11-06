import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { configureGit, git, makeCompanionProject, makeTempDir, runMain } from "./helpers.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("conventions command", () => {
  it("renders configured conventions, local work files, and ignored searches", async () => {
    const cwd = makeProject();
    mkdirSync(join(cwd, ".plans"));
    mkdirSync(join(cwd, ".local"));
    mkdirSync(join(cwd, ".local-wt"));
    writeFileSync(join(cwd, ".gitignore"), ".plans\n.local\n.local-wt\n");
    writeFileSync(
      join(cwd, "alignfirst.json"),
      JSON.stringify({
        schemaVersion: 1,
        conventions: {
          ticketIdPattern: "^\\d+$",
          git: {
            defaultBranch: "main",
            branchNameTemplate: "{TICKET_ID}/{slug-1-3-words}",
            commit: { style: "conventionalCommit", ticketReference: "bracketedHash" },
            agentCoauthoring: false,
          },
        },
        plans: { autoArchive: true },
      }),
    );
    const result = await runMain(["conventions"], { cwd });
    for (const value of [
      "^\\d+$",
      "{TICKET_ID}/{slug-1-3-words}",
      "type: [#TICKET_ID] summary",
      ".plans",
      ".local",
      ".local-wt",
    ])
      expect(result.stdout).toContain(value);
  });

  it("gives the absolute path of a companion .plans and leaves it out of the searches", async () => {
    const { root, home, project, companion } = makeCompanionProject({ ".plans": "companion" });
    dirs.push(root);
    mkdirSync(join(companion, ".plans"), { recursive: true });
    mkdirSync(join(project, ".plans"));
    mkdirSync(join(project, ".local"));
    writeFileSync(join(project, ".gitignore"), ".plans\n.local\n");
    const result = await runMain(["conventions"], { cwd: project, home });
    expect(result.stdout).toContain(join(companion, ".plans"));
    expect(result.stdout).toContain(".local");
    expect(result.stdout).not.toContain("`.plans`");
  });

  it("does not list an ignored directory that contains tracked files", async () => {
    const cwd = makeProject();
    mkdirSync(join(cwd, ".local"));
    writeFileSync(join(cwd, ".local", "file"), "tracked\n");
    git(cwd, "add", "-f", ".local/file");
    git(cwd, "commit", "--quiet", "-m", "track local");
    writeFileSync(join(cwd, ".gitignore"), ".local\n");
    expect((await runMain(["conventions"], { cwd })).stdout).not.toContain(".local");
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
