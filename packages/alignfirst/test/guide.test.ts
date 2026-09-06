import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PROTOCOLS } from "../src/protocols.js";
import { configureGit, git, makeTempDir, runMain } from "./helpers.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("guide command", () => {
  it("renders protocol selection and shared conventions by default", async () => {
    const result = await runMain(["guide"], { cwd: temp() });
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("# AlignFirst Guide");
    expect(result.stdout).toContain("alignfirst guide spec");
    expect(result.stdout.indexOf("# Shared Conventions")).toBeGreaterThan(
      result.stdout.indexOf("## Choose a protocol"),
    );
    expect(result.stdout).not.toContain("# How to Write a Technical Specification");
    expect(result.stdout.endsWith("\n")).toBe(true);
    expect(result.stdout.endsWith("\n\n")).toBe(false);
  });

  it("renders every complete protocol before shared conventions, without the catalogue", async () => {
    const cwd = temp();
    const selection = await runMain(["guide"], { cwd });
    const shared = selection.stdout.slice(selection.stdout.indexOf("# Shared Conventions"));
    for (const protocol of PROTOCOLS) {
      const combined = await runMain(["guide", protocol], { cwd });
      const protocolOnly = await runMain(["guide", protocol, "--protocol-only"], { cwd });
      expect(combined.code).toBe(0);
      expect(protocolOnly.code).toBe(0);
      const [title, ...sections] = protocolOnly.stdout.trimEnd().split("\n\n");
      expect(combined.stdout.startsWith(`${title}\n\n`)).toBe(true);
      expect(combined.stdout).toContain(
        "This guide includes the selected protocol and shared conventions. Read both before starting.",
      );
      expect(combined.stdout.endsWith(`${sections.join("\n\n")}\n\n${shared}`)).toBe(true);
      expect(combined.stdout).not.toContain("# AlignFirst Guide");
      expect(combined.stdout).not.toContain("guide overview");
      expect(protocolOnly.stdout).not.toContain("# Shared Conventions");
    }
  });

  it("renders every protocol and the overview", async () => {
    const cwd = temp();
    for (const protocol of PROTOCOLS) {
      const result = await runMain(["guide", protocol, "--protocol-only"], { cwd });
      expect(result.code).toBe(0);
      expect(result.stdout).not.toBe("");
    }
    const overview = await runMain(["guide", "overview"], { cwd });
    expect(overview.stdout).toContain("# AlignFirst Overview");
    expect(overview.stdout).not.toContain("# AlignFirst Guide");
    expect(overview.stdout).not.toContain("# Shared Conventions");
  });

  it("rejects invalid protocol selections", async () => {
    const cwd = temp();
    const overviewOnly = await runMain(["guide", "overview", "--protocol-only"], { cwd });
    expect(overviewOnly.code).toBe(1);
    expect(overviewOnly.stderr).toContain("--protocol-only cannot be used with overview");

    const missing = await runMain(["guide", "--protocol-only"], { cwd });
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("--protocol-only requires a protocol");

    const unknown = await runMain(["guide", "unknown"], { cwd });
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toBe(
      'Unknown protocol "unknown". Protocols: spec, plan, aad, catchup, merge, review, description, or overview.\n',
    );
  });

  it("composes reviewer rules in order", async () => {
    const result = await runMain(
      [
        "guide",
        "review",
        "--reviewer",
        "correctness",
        "--module",
        "typescript-strict",
        "--module",
        "javascript",
      ],
      { cwd: temp() },
    );
    const commonIndex = result.stdout.indexOf("# Code Reviewer — Common Rules");
    const perspectiveIndex = result.stdout.indexOf("# Perspective — Correctness");
    const typescriptIndex = result.stdout.indexOf("# Ecosystem Module — Strict TypeScript");
    const javascriptIndex = result.stdout.indexOf(
      "# Ecosystem Module — JavaScript and Non-Strict TypeScript",
    );
    expect(commonIndex).toBeGreaterThanOrEqual(0);
    expect(perspectiveIndex).toBeGreaterThan(commonIndex);
    expect(typescriptIndex).toBeGreaterThan(perspectiveIndex);
    expect(javascriptIndex).toBeGreaterThan(typescriptIndex);
    expect(result.stdout).not.toContain("# AlignFirst Guide");
    expect(result.stdout).not.toContain("# Shared Conventions");
    expect(result.stdout).not.toContain("# How to Write a Code Review Report");
  });

  it("rejects invalid reviewer selections", async () => {
    const cwd = temp();
    const wrongProtocol = await runMain(["guide", "spec", "--reviewer", "correctness"], { cwd });
    expect(wrongProtocol.stderr).toContain("--reviewer can only be used with review");

    const missingReviewer = await runMain(["guide", "review", "--module", "python"], {
      cwd,
    });
    expect(missingReviewer.stderr).toContain("--module requires --reviewer");

    const unknownModule = await runMain(
      ["guide", "review", "--reviewer", "quality", "--module", "ruby"],
      { cwd },
    );
    expect(unknownModule.stderr).toContain(
      'Unknown module "ruby". Modules: typescript-strict, javascript, python.',
    );

    const unknownReviewer = await runMain(["guide", "review", "--reviewer", "style"], {
      cwd,
    });
    expect(unknownReviewer.stderr).toContain(
      'Unknown reviewer "style". Reviewers: intent, correctness, safety, quality.',
    );
  });

  it("resolves every template placeholder", async () => {
    const cwd = temp();
    const argumentSets: string[][] = [["guide"], ["guide", "overview"]];
    for (const protocol of PROTOCOLS) {
      argumentSets.push(["guide", protocol], ["guide", protocol, "--protocol-only"]);
    }
    for (const reviewer of ["intent", "correctness", "safety", "quality"]) {
      argumentSets.push(["guide", "review", "--reviewer", reviewer]);
      for (const module of ["typescript-strict", "javascript", "python"]) {
        argumentSets.push(["guide", "review", "--reviewer", reviewer, "--module", module]);
      }
    }
    for (const args of argumentSets) {
      const result = await runMain(args, { cwd });
      expect(result.stdout, args.join(" ")).not.toContain("{{");
    }
  });

  it("renders the npm command form", async () => {
    const result = await runMain(["guide"], {
      cwd: temp(),
      env: { npm_config_user_agent: "npm/11.0.0 node/v22.0.0" },
    });
    expect(result.stdout).toContain("npx -y alignfirst guide spec");
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
      join(cwd, ".alignfirst.json"),
      JSON.stringify({ schemaVersion: 1, ticketIdPattern: "^\\d+$" }),
    );
    const detected = await runMain(["guide", "spec"], { cwd });
    expect(detected.stdout).toContain("Current ticket: `78`");
    expect(detected.stdout).toContain("alignfirst ticket --next spec.md --new-cycle");

    git(cwd, "checkout", "-q", "main");
    const noMatch = await runMain(["guide", "spec"], { cwd });
    expect(noMatch.stdout).toContain("No ticket id on branch `main`");
    expect(noMatch.stdout).toContain("alignfirst ticket <id> --next spec.md --new-cycle");

    writeFileSync(join(cwd, ".alignfirst.json"), '{"schemaVersion":1}');
    const noPattern = await runMain(["guide"], { cwd });
    expect(noPattern.stdout).toContain("Ask the user for the ticket ID when it is not given.");
  });

  it("renders plans, commit, base branch, and conventions placeholders", async () => {
    const cwd = temp();
    const unconfigured = await runMain(["guide"], { cwd });
    expect(unconfigured.stdout).toContain("No .plans/ directory in the current directory.");
    expect(unconfigured.stdout).toContain("## Project conventions");

    mkdirSync(join(cwd, ".plans"));
    writeFileSync(
      join(cwd, ".alignfirst.json"),
      JSON.stringify({
        schemaVersion: 1,
        git: {
          defaultBranch: "main",
          commit: { style: "conventionalCommit", ticketReference: "bracketedHash" },
        },
      }),
    );
    const spec = await runMain(["guide", "spec", "--protocol-only"], { cwd });
    expect(spec.stdout).toContain(
      "(project convention: `type: [#ticketId] summary`; `type: summary` for `side-N`)",
    );
    const review = await runMain(["guide", "review", "--protocol-only"], { cwd });
    expect(review.stdout).toContain("fall back to `main`, the default branch");
    const merge = await runMain(["guide", "merge", "--protocol-only"], { cwd });
    expect(merge.stdout).toContain("otherwise merge `main`, the default branch");
    expect((await runMain(["guide"], { cwd })).stdout).not.toContain("## Project conventions");
  });
});

function temp(): string {
  const dir = makeTempDir();
  dirs.push(dir);
  return dir;
}
