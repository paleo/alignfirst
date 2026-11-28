import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { writeConfig } from "../helpers.js";
import {
  type Fixture,
  makeFixture,
  makeRepository,
  type RunOverrides,
  type RunResult,
  runAligndev,
  useProjectFixtures,
} from "../project/fixtures.js";
import { writeAlignfirstStub } from "../stand-ins.js";

const OPENCLAW_CONFIG = { projectsRoot: "~/projects", code: { harness: "claude" } };
const OPENCLAW_ENV = { ALIGNDEV_ASSISTANT_HARNESS: "openclaw" };

useProjectFixtures();

describe("OpenClaw guide", () => {
  it("serves the openclaw playbook under an OpenClaw exec unless a coding agent is detected", async () => {
    const fixture = makeFixture();
    writeConfig(fixture.home, OPENCLAW_CONFIG);
    const args = ["--channel", "slack"];
    expect((await runGuide(fixture, args, { env: { OPENCLAW_SHELL: "exec" } })).code).toBe(0);
    const detected = { OPENCLAW_SHELL: "exec", CODEX_THREAD_ID: "thread" };
    expect((await runGuide(fixture, args, { env: detected })).code).toBe(1);
  });

  it("requires projectsRoot", async () => {
    const fixture = makeFixture();
    writeConfig(fixture.home, { code: { harness: "claude" } });
    const result = await runGuide(fixture, ["--channel", "slack", "consultation"], {
      env: OPENCLAW_ENV,
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
  });

  it.each([
    ["--channel", "slack", "nope"],
    ["--root", "/unused"],
    ["code", "--root", "/unused"],
    ["code", "project"],
    ["working-session"],
    ["--channel", "slack", "project"],
    ["--channel", "teams", "working-session"],
    ["--channel", "app", "message-tool"],
    ["project", "--root", "/unused"],
  ])("rejects invalid OpenClaw arguments %j", async (...args) => {
    const fixture = makeFixture();
    writeConfig(fixture.home, OPENCLAW_CONFIG);
    const result = await runGuide(fixture, args, { env: OPENCLAW_ENV });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
  });

  it("uses the app surface when OpenClaw gets no --channel", async () => {
    const fixture = makeFixture();
    writeConfig(fixture.home, OPENCLAW_CONFIG);
    const overrides = { env: OPENCLAW_ENV };
    const result = await runGuide(fixture, ["code"], overrides);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      (await runGuide(fixture, ["--channel", "app", "code"], overrides)).stdout,
    );
    expect(result.stdout).not.toBe(
      (await runGuide(fixture, ["--channel", "slack", "code"], overrides)).stdout,
    );
  });

  it("prints the static project guide without projectsRoot or alignfirst executable", async () => {
    const fixture = makeFixture();
    makeRepository(fixture.root, "discovered-project");
    writeConfig(fixture.home, { code: { harness: "claude" } });
    const result = await runGuide(fixture, ["project"], {
      env: OPENCLAW_ENV,
      alignfirstCommand: ["/nonexistent/alignfirst"],
    });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("discovered-project");
    expect(result.stdout).not.toContain(realpathSync(fixture.root));
  });
});

describe("OpenClaw global assistant instructions", () => {
  it("prints the file verbatim in the dispatcher", async () => {
    const fixture = makeFixture();
    writeConfig(fixture.home, OPENCLAW_CONFIG);
    const content = "Prefer the `pi` profile.\n{{#openclaw}}\nRun {{ALIGNDEV}} guide first.";
    const path = writeGlobalInstructions(fixture, `${content}\n\n \n`);
    const result = await runGuide(fixture, [], { env: OPENCLAW_ENV });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(path);
    expect(result.stdout).toContain(content);
    expect(result.stdout).not.toContain(`${content}\n\n`);
  });

  it.each([
    ["an absent", undefined],
    ["a whitespace-only", " \n\t\n"],
  ])("does not name the path with %s file", async (_, text) => {
    const fixture = makeFixture();
    const path = join(fixture.home, ".alignfirst", "ASSISTANTS.md");
    if (text !== undefined) writeGlobalInstructions(fixture, text);
    writeConfig(fixture.home, OPENCLAW_CONFIG);
    const result = await runGuide(fixture, [], { env: OPENCLAW_ENV });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).not.toContain(path);
    expect(result.stdout).not.toContain("<assistant-instructions");
  });
});

function runGuide(
  fixture: Fixture,
  args: string[],
  overrides: RunOverrides = {},
): Promise<RunResult> {
  return runAligndev(fixture, ["guide", ...args], {
    alignfirstCommand: writeAlignfirstStub(fixture.base, overrides.cwd ?? fixture.root).command,
    ...overrides,
  });
}

function writeGlobalInstructions(fixture: Fixture, text: string): string {
  const path = join(fixture.home, ".alignfirst", "ASSISTANTS.md");
  mkdirSync(join(fixture.home, ".alignfirst"), { recursive: true });
  writeFileSync(path, text);
  return path;
}
