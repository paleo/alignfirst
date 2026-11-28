import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveCommandForms } from "../src/command-form.js";
import { renderCodeGuide } from "../src/guide/code-guide.js";
import { type ActiveBlocks, renderBlocks } from "../src/guide/render-template.js";
import { PLAYBOOK_TOPICS } from "../src/guide/topics.js";
import { writeConfig, writeSettings } from "./helpers.js";
import {
  addInitialCommit,
  addWorktree,
  type Fixture,
  makeFixture,
  makeRepository,
  type RunOverrides,
  type RunResult,
  runAligndev,
  useProjectFixtures,
} from "./project/fixtures.js";
import { writeAlignfirstStub } from "./stand-ins.js";

const CODING_AGENT_CONFIG = { code: { harness: "claude" } };
const GLOBAL_FORMS = resolveCommandForms({});

useProjectFixtures();

describe("renderCodeGuide", () => {
  it("renders the configured model list instead of the defaults", () => {
    const guide = renderCodeGuide({
      active: { platform: "codingAgent" },
      forms: GLOBAL_FORMS,
      harness: "claude",
      models: ["sonnet", "haiku"],
      efforts: [],
    });
    expect(guide).toContain("sonnet");
    expect(guide).toContain("haiku");
    expect(guide).not.toContain("fable");
  });
});

describe("guide code profile table", () => {
  const PROFILE_NAMES = ["`work`", "`local`", "`off`", "`assistant`"];

  it("lists the enabled coding-agent profiles and marks the selected one", async () => {
    const fixture = makeFixture();
    writeSettings(fixture.home, {
      code: {
        fallbackProfile: "work",
        profiles: {
          work: {
            harness: "claude",
            default: true,
            defaultModel: "opus",
            modelAliases: { fast: "model-a" },
          },
          local: {
            harness: "pi",
            modelAliases: { quick: "provider/model-b" },
            efforts: ["shallow", "deep"],
            defaultEffort: "deep",
          },
          off: { harness: "codex", disabled: true },
          assistant: { harness: "openclaw", defaultAgentProfile: "work" },
        },
      },
    });
    const result = await runGuide(fixture, ["code", "--profile", "local"]);
    expect(result.code, result.stderr).toBe(0);
    const rows = result.stdout
      .split("\n")
      .filter((line) => PROFILE_NAMES.some((name) => line.startsWith(`| ${name} |`)));
    expect(rows.map((row) => row.split(" | ")[0])).toEqual(["| `work`", "| `local`"]);
    expect(rows[0]).toContain("`opus`");
    expect(rows[1]).toContain("`shallow`, `deep`");
  });
});

describe("the assistant's harness in the guide", () => {
  it("shows the guide help even with an invalid ALIGNDEV_ASSISTANT_HARNESS", async () => {
    const result = await runGuide(makeFixture(), ["--help"], {
      env: { ALIGNDEV_ASSISTANT_HARNESS: "openclow" },
    });
    expect(result.code, result.stderr).toBe(0);
  });
});

describe("aligndev guide validation", () => {
  it("requires a configured or detected agent for the code topic only", async () => {
    const fixture = makeFixture();
    expect((await runGuide(fixture, ["code"])).code).toBe(1);
    for (const args of [[], ["working-session"]]) {
      expect((await runGuide(fixture, args)).code).toBe(0);
    }
  });

  it.each([["--channel", "slack"], ["channel-handling"], ["project"]])(
    "rejects OpenClaw-only arguments %j under codingAgent",
    async (...args) => {
      const fixture = makeFixture();
      writeConfig(fixture.home, CODING_AGENT_CONFIG);
      const result = await runGuide(fixture, args);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
    },
  );
});

describe("guide project boundaries", () => {
  it("renders playbook topics without a project report or discovered instructions", async () => {
    const fixture = makeFixture();
    writeConfig(fixture.home, CODING_AGENT_CONFIG);
    const main = makeRepository(fixture.root, "project", {
      assistantInstructionsFile: "handbook.md",
    });
    writeFileSync(join(main, "handbook.md"), "Main guide\n");
    const linked = join(fixture.root, "linked");
    addInitialCommit(main);
    addWorktree(main, linked, "feature");
    const nested = join(linked, "src", "nested");
    mkdirSync(nested, { recursive: true });
    for (const cwd of [main, nested, fixture.root]) {
      for (const args of [[], ...PLAYBOOK_TOPICS.codingAgent.map((topic) => [topic])]) {
        const result = await runGuide(fixture, args, {
          cwd,
          alignfirstCommand: ["/nonexistent/alignfirst"],
        });
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).not.toContain("Main guide");
      }
    }
  });

  it("propagates report failures for guide code", async () => {
    const fixture = makeFixture();
    writeConfig(fixture.home, CODING_AGENT_CONFIG);
    const result = await runGuide(fixture, ["code"], {
      cwd: makeRepository(fixture.root, "project"),
      alignfirstCommand: ["/bin/sh", "-c", "echo 'Error: broken registry.' >&2; exit 1"],
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("broken registry");
  });
});

describe("global assistant instructions", () => {
  it("prints the file verbatim in the dispatcher", async () => {
    const fixture = makeFixture();
    writeConfig(fixture.home, CODING_AGENT_CONFIG);
    const content = "Prefer the `pi` profile.\n{{#openclaw}}\nRun {{ALIGNDEV}} guide first.";
    const path = writeGlobalInstructions(fixture, `${content}\n\n \n`);
    const result = await runGuide(fixture, [], { env: { CLAUDECODE: "1" } });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(path);
    expect(result.stdout).toContain(content);
    expect(result.stdout).not.toContain(`${content}\n\n`);
  });

  it.each([
    ["an absent", undefined],
    ["a whitespace-only", " \n\t\n"],
  ])("names the path with %s file", async (_, text) => {
    const fixture = makeFixture();
    const path = join(fixture.home, ".alignfirst", "ASSISTANTS.md");
    if (text !== undefined) writeGlobalInstructions(fixture, text);
    writeConfig(fixture.home, CODING_AGENT_CONFIG);
    const codingAgent = await runGuide(fixture, [], { env: { CLAUDECODE: "1" } });
    expect(codingAgent.code, codingAgent.stderr).toBe(0);
    expect(codingAgent.stdout).toContain(path);
    expect(codingAgent.stdout).not.toContain("<assistant-instructions");
  });

  it("fails the dispatcher when the file cannot be read", async () => {
    const fixture = makeFixture();
    writeConfig(fixture.home, CODING_AGENT_CONFIG);
    const path = join(fixture.home, ".alignfirst", "ASSISTANTS.md");
    mkdirSync(path);
    const result = await runGuide(fixture, [], { env: { CLAUDECODE: "1" } });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(path);
  });

  it.each([["working-session"], ["code"]])("leaves the file out of guide %s", async (topic) => {
    const fixture = makeFixture();
    writeConfig(fixture.home, CODING_AGENT_CONFIG);
    const path = writeGlobalInstructions(fixture, "Prefer the `pi` profile.\n");
    const result = await runGuide(fixture, [topic], { env: { CLAUDECODE: "1" } });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("Prefer the `pi` profile.");
    expect(result.stdout).not.toContain(path);
  });
});

describe("renderBlocks", () => {
  it("keeps the active platform's input and preserves non-block placeholders", () => {
    const text = [
      "Shared.",
      "{{#openclaw}}",
      "OpenClaw only.",
      "{{/openclaw}}",
      "{{#codingAgent}}",
      "Coding agent only.",
      "{{/codingAgent}}",
      "{{PLACEHOLDER}}",
    ].join("\n");
    expect(renderBlocks(text, { platform: "openclaw" }, "t.md")).toBe(
      "Shared.\nOpenClaw only.\n{{PLACEHOLDER}}",
    );
    expect(renderBlocks(text, { platform: "codingAgent" }, "t.md")).toBe(
      "Shared.\nCoding agent only.\n{{PLACEHOLDER}}",
    );
  });

  it("selects nested blocks by surface and derived context", () => {
    const text = [
      "{{#openclaw}}",
      "OpenClaw.",
      "{{#slack}}",
      "Slack.",
      "{{/slack}}",
      "{{#discord}}",
      "Discord.",
      "{{/discord}}",
      "{{#app}}",
      "App.",
      "{{/app}}",
      "{{#thread}}",
      "Thread.",
      "{{/thread}}",
      "{{/openclaw}}",
      "{{#conversation}}",
      "Conversation.",
      "{{/conversation}}",
      "{{#codingAgent}}",
      "{{#conversation}}",
      "Assistant.",
      "{{/conversation}}",
      "{{/codingAgent}}",
    ].join("\n");
    const render = (active: ActiveBlocks) => renderBlocks(text, active, "t.md").split("\n");
    expect(render({ platform: "openclaw", surface: "slack" })).toEqual([
      "OpenClaw.",
      "Slack.",
      "Thread.",
    ]);
    expect(render({ platform: "openclaw", surface: "discord" })).toEqual([
      "OpenClaw.",
      "Discord.",
      "Thread.",
    ]);
    expect(render({ platform: "openclaw", surface: "app" })).toEqual([
      "OpenClaw.",
      "App.",
      "Conversation.",
    ]);
    expect(render({ platform: "openclaw" })).toEqual(["OpenClaw."]);
    expect(render({ platform: "codingAgent" })).toEqual(["Conversation.", "Assistant."]);
  });

  it("keeps the assistant's harness block, or every harness block when it is unrecognized", () => {
    const text = [
      "{{#codingAgent}}",
      "{{#claude}}",
      "Claude Code.",
      "{{/claude}}",
      "{{#codex}}",
      "Codex.",
      "{{/codex}}",
      "{{#pi}}",
      "Pi.",
      "{{/pi}}",
      "{{#agy}}",
      "Antigravity.",
      "{{/agy}}",
      "{{/codingAgent}}",
    ].join("\n");
    const render = (active: ActiveBlocks) => renderBlocks(text, active, "t.md").split("\n");
    expect(render({ platform: "codingAgent", harness: "pi" })).toEqual(["Pi."]);
    expect(render({ platform: "codingAgent" })).toEqual([
      "Claude Code.",
      "Codex.",
      "Pi.",
      "Antigravity.",
    ]);
  });

  it.each([
    ["an unknown block", "{{#teams}}\nx\n{{/teams}}"],
    [
      "a platform block inside a platform block",
      "{{#openclaw}}\n{{#codingAgent}}\nx\n{{/codingAgent}}\n{{/openclaw}}",
    ],
    [
      "a surface block inside codingAgent",
      "{{#codingAgent}}\n{{#slack}}\nx\n{{/slack}}\n{{/codingAgent}}",
    ],
    ["a harness block at the top level", "{{#pi}}\nx\n{{/pi}}"],
    ["an unclosed block", "a\n{{#openclaw}}\nx"],
    ["a stray closing marker", "{{#openclaw}}\nx\n{{/codingAgent}}"],
  ])("rejects %s", (_name, text) => {
    expect(() => renderBlocks(text, { platform: "openclaw" }, "playbook/t.md")).toThrow(Error);
  });
});

function runGuide(
  fixture: Fixture,
  args: string[],
  overrides: RunOverrides = {},
): Promise<RunResult> {
  const cwd = overrides.cwd ?? fixture.root;
  return runAligndev(fixture, ["guide", ...args], {
    alignfirstCommand: writeAlignfirstStub(fixture.base, cwd).command,
    ...overrides,
  });
}

function writeGlobalInstructions(fixture: Fixture, text: string): string {
  const path = join(fixture.home, ".alignfirst", "ASSISTANTS.md");
  mkdirSync(join(fixture.home, ".alignfirst"), { recursive: true });
  writeFileSync(path, text);
  return path;
}
