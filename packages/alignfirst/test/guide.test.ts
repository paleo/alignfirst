import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { configureGit, git, makeTempDir, runMain } from "./helpers.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("guide command", () => {
  it.each([
    ["overview with --protocol-only", ["overview", "--protocol-only"]],
    ["--protocol-only without a protocol", ["--protocol-only"]],
    ["an unknown protocol", ["unknown"]],
    ["a reviewer outside review", ["spec", "--reviewer", "correctness"]],
    ["a module without a reviewer", ["review", "--module", "python"]],
    ["an unknown module", ["review", "--reviewer", "quality", "--module", "ruby"]],
    ["an unknown reviewer", ["review", "--reviewer", "style"]],
    ["a module with the light reviewer", ["review", "--reviewer", "light", "--module", "python"]],
  ])("rejects %s", async (_case, args) => {
    const result = await runMain(["guide", ...args], { cwd: temp() });
    expect(result).toMatchObject({ code: 1, stdout: "" });
  });

  it("renders the ticket detected from the branch", async () => {
    const cwd = temp();
    configureGit(cwd);
    git(cwd, "init", "--quiet");
    writeFileSync(join(cwd, "README.md"), "project\n");
    git(cwd, "add", "-A");
    git(cwd, "commit", "--quiet", "-m", "init");
    git(cwd, "checkout", "-q", "-b", "78/x");
    writeFileSync(
      join(cwd, "alignfirst.json"),
      JSON.stringify({ schemaVersion: 1, conventions: { ticketIdPattern: "^\\d+$" } }),
    );
    const detected = await runMain(["guide", "spec"], { cwd });
    expect(detected.stdout).toContain("78");
    expect(detected.stdout).toContain("alignfirst ticket --next spec.md --new-cycle");
  });

  it("includes the configured commit format and default branch", async () => {
    const cwd = temp();
    mkdirSync(join(cwd, ".plans"));
    writeFileSync(
      join(cwd, "alignfirst.json"),
      JSON.stringify({
        schemaVersion: 1,
        conventions: {
          git: {
            defaultBranch: "release/integration",
            commit: { style: "conventionalCommit", ticketReference: "bracketedHash" },
          },
        },
      }),
    );
    const spec = await runMain(["guide", "spec", "--protocol-only"], { cwd });
    expect(spec.stdout).toContain("type: [#TICKET_ID] summary");
    const review = await runMain(["guide", "review", "--protocol-only"], { cwd });
    expect(review.stdout).toContain("release/integration");
    const merge = await runMain(["guide", "merge", "--protocol-only"], { cwd });
    expect(merge.stdout).toContain("release/integration");
  });
});

function temp(): string {
  const dir = makeTempDir();
  dirs.push(dir);
  return dir;
}
