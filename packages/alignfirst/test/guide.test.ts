import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PROTOCOLS } from "../src/protocols.js";
import { makeTempDir, runMain } from "./helpers.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("guide command", () => {
  it("renders the core guide by default", async () => {
    const result = await runMain(["guide"], { cwd: temp() });
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("# AlignFirst Guide");
    expect(result.stdout).toContain("alignfirst guide spec --protocol-only");
    expect(result.stdout).not.toContain("# How to Write a Technical Specification");
    expect(result.stdout.endsWith("\n")).toBe(true);
    expect(result.stdout.endsWith("\n\n")).toBe(false);
  });

  it("renders a protocol after the core or alone", async () => {
    const cwd = temp();
    const combined = await runMain(["guide", "spec"], { cwd });
    const coreIndex = combined.stdout.indexOf("# AlignFirst Guide");
    const protocolIndex = combined.stdout.indexOf("# How to Write a Technical Specification");
    expect(coreIndex).toBeGreaterThanOrEqual(0);
    expect(protocolIndex).toBeGreaterThan(coreIndex);

    const protocolOnly = await runMain(["guide", "spec", "--protocol-only"], { cwd });
    expect(protocolOnly.stdout).toContain("# How to Write a Technical Specification");
    expect(protocolOnly.stdout).not.toContain("# AlignFirst Guide");
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
    expect(result.stdout).toContain("npx -y alignfirst guide spec --protocol-only");
  });

  it("renders the configured ticket rule", async () => {
    const cwd = temp();
    writeFileSync(
      join(cwd, ".alignfirst.json"),
      JSON.stringify({ schemaVersion: 1, ticketPattern: "^AF-\\d+$" }),
    );
    const configured = await runMain(["guide"], { cwd });
    expect(configured.stdout).toContain("Ticket IDs match `^AF-\\d+$`");
    expect(configured.stdout).toContain("alignfirst ticket` without an id");

    const unconfigured = await runMain(["guide"], { cwd: temp() });
    expect(unconfigured.stdout).toContain("Ask the user for the ticket ID when it is not given.");
  });

  it("appends overlay project conventions unless the root has them", async () => {
    const cwd = temp();
    const overlays = join(cwd, "overlays");
    const overlayDir = join(overlays, "project", "_project");
    mkdirSync(overlayDir, { recursive: true });
    writeFileSync(
      join(overlayDir, ".alignfirst.json"),
      JSON.stringify({ schemaVersion: 1, project: { paths: [realpathSync(cwd)] } }),
    );
    writeFileSync(join(overlayDir, "AGENTS.md"), "Overlay convention.\n");
    const env = { ALIGNFIRST_OVERLAYS: overlays };

    const overlay = await runMain(["guide"], { cwd, env });
    expect(overlay.stdout).toContain("## Project conventions\n\nOverlay convention.");

    writeFileSync(join(cwd, "AGENTS.md"), "Root convention.\n");
    const root = await runMain(["guide"], { cwd, env });
    expect(root.stdout).not.toContain("## Project conventions");
    expect(root.stdout).not.toContain("Overlay convention.");
  });
});

function temp(): string {
  const dir = makeTempDir();
  dirs.push(dir);
  return dir;
}
