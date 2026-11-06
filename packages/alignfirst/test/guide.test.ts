import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { configureGit, git, makeTempDir, runMain } from "./helpers.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("guide command", () => {
  it("rejects invalid protocol selections", async () => {
    const cwd = temp();
    const overviewOnly = await runMain(["guide", "overview", "--protocol-only"], { cwd });
    expect(overviewOnly.code).toBe(1);
    expect(overviewOnly.stdout).toBe("");

    const missing = await runMain(["guide", "--protocol-only"], { cwd });
    expect(missing.code).toBe(1);
    expect(missing.stdout).toBe("");

    const unknown = await runMain(["guide", "unknown"], { cwd });
    expect(unknown.code).toBe(1);
    expect(unknown.stdout).toBe("");
  });

  it("rejects invalid reviewer selections", async () => {
    const cwd = temp();
    const wrongProtocol = await runMain(["guide", "spec", "--reviewer", "correctness"], { cwd });
    expect(wrongProtocol).toMatchObject({ code: 1, stdout: "" });

    const missingReviewer = await runMain(["guide", "review", "--module", "python"], {
      cwd,
    });
    expect(missingReviewer).toMatchObject({ code: 1, stdout: "" });

    const unknownModule = await runMain(
      ["guide", "review", "--reviewer", "quality", "--module", "ruby"],
      { cwd },
    );
    expect(unknownModule).toMatchObject({ code: 1, stdout: "" });

    const unknownReviewer = await runMain(["guide", "review", "--reviewer", "style"], {
      cwd,
    });
    expect(unknownReviewer).toMatchObject({ code: 1, stdout: "" });
  });

  it("renders ticket detection and fallback variants", async () => {
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

    git(cwd, "checkout", "-q", "-b", "side-8/x");
    const sideWithPattern = await runMain(["guide", "spec"], { cwd });
    expect(sideWithPattern.stdout).toContain("side-8");
    writeFileSync(join(cwd, "alignfirst.json"), '{"schemaVersion":1}');
    const sideWithoutPattern = await runMain(["guide", "spec"], { cwd });
    expect(sideWithoutPattern.stdout).toContain("side-8");

    git(cwd, "checkout", "-q", "main");
    writeFileSync(
      join(cwd, "alignfirst.json"),
      JSON.stringify({ schemaVersion: 1, conventions: { ticketIdPattern: "^\\d+$" } }),
    );
    const noMatch = await runMain(["guide", "spec"], { cwd });
    expect(noMatch.stdout).toContain("alignfirst ticket <id> --next spec.md --new-cycle");
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
