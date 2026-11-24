import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveCommandForms } from "../src/command-form.js";
import { renderCodeGuide } from "../src/guide/code-guide.js";
import { type ActiveBlocks, renderBlocks } from "../src/guide/render-template.js";
import { PLAYBOOK_TOPICS } from "../src/guide/topics.js";
import { writeConfig, writeSettings } from "./helpers.js";
import {
  addWorktree,
  type Fixture,
  makeFixture,
  makeRepository,
  type RunOverrides,
  type RunResult,
  runAligndev,
  useProjectFixtures,
} from "./project/fixtures.js";

const OPENCLAW_CONFIG = { projectsRoot: "~/projects", code: { harness: "claude" } };
const CODING_AGENT_CONFIG = { code: { harness: "claude" } };
const OPENCLAW_ENV = { ALIGNDEV_ASSISTANT_HARNESS: "openclaw" };
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
            modelAliases: { fast: "haiku" },
          },
          local: {
            harness: "pi",
            modelAliases: { quick: "openai/luna" },
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
      .map((line) => line.split(" | ").map((cell) => cell.replace(/^\| | \|$/g, "")))
      .filter((cells) => PROFILE_NAMES.includes(cells[0]));
    expect(rows).toEqual([
      [
        "`work`",
        "claude",
        "no",
        "yes",
        expect.stringContaining("`fast`"),
        "`opus`",
        "`low`, `medium`, `high`, `xhigh`, `max`",
        "native default",
      ],
      [
        "`local`",
        "pi",
        "yes",
        "no",
        expect.stringMatching(/native selector.*`quick`/),
        expect.any(String),
        "`shallow`, `deep`",
        "`deep`",
      ],
    ]);
  });

  it("renders without a named profile", async () => {
    const fixture = makeFixture();
    const result = await runGuide(fixture, ["code"], { env: { CLAUDECODE: "1" } });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("{{");
  });
});

describe("the assistant's harness in the guide", () => {
  it("serves the openclaw playbook under an OpenClaw exec unless a coding agent is detected", async () => {
    const fixture = makeFixture();
    writeConfig(fixture.home, OPENCLAW_CONFIG);
    const args = ["--channel", "slack"];
    expect((await runGuide(fixture, args, { env: { OPENCLAW_SHELL: "exec" } })).code).toBe(0);
    const detected = { OPENCLAW_SHELL: "exec", CODEX_THREAD_ID: "thread" };
    expect((await runGuide(fixture, args, { env: detected })).code).toBe(1);
  });

  it("fails on an invalid ALIGNDEV_ASSISTANT_HARNESS", async () => {
    const fixture = makeFixture();
    const result = await runGuide(fixture, [], { env: { ALIGNDEV_ASSISTANT_HARNESS: "openclow" } });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
  });

  it("shows the guide help even with an invalid ALIGNDEV_ASSISTANT_HARNESS", async () => {
    const result = await runGuide(makeFixture(), ["--help"], {
      env: { ALIGNDEV_ASSISTANT_HARNESS: "openclow" },
    });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("ALIGNDEV_ASSISTANT_HARNESS");
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
  ])("rejects invalid OpenClaw arguments %j", async (...args) => {
    const fixture = makeFixture();
    writeConfig(fixture.home, OPENCLAW_CONFIG);
    const result = await runGuide(fixture, args, { env: OPENCLAW_ENV });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
  });

  it.each([
    ["--channel", "slack"],
    ["channel-handling"],
    ["project-lifecycle"],
    ["message-tool"],
    ["project"],
  ])("rejects OpenClaw-only arguments %j under codingAgent", async (...args) => {
    const fixture = makeFixture();
    writeConfig(fixture.home, CODING_AGENT_CONFIG);
    const result = await runGuide(fixture, args);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
  });
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
      alignfirstCommand: [
        "node",
        "-e",
        "console.error('Error: broken registry.'); process.exit(1)",
      ],
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("broken registry");
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

  it("rejects --root on the project guide", async () => {
    const fixture = makeFixture();
    writeConfig(fixture.home, OPENCLAW_CONFIG);
    const result = await runGuide(fixture, ["project", "--root", fixture.root], {
      env: OPENCLAW_ENV,
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
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
    [
      "a thread block inside codingAgent",
      "{{#codingAgent}}\n{{#thread}}\nx\n{{/thread}}\n{{/codingAgent}}",
    ],
    [
      "a platform block inside a surface block",
      "{{#app}}\n{{#openclaw}}\nx\n{{/openclaw}}\n{{/app}}",
    ],
    ["an unclosed block", "a\n{{#openclaw}}\nx"],
    ["a stray closing marker", "{{#openclaw}}\nx\n{{/codingAgent}}"],
  ])("rejects %s", (_name, text) => {
    expect(() => renderBlocks(text, { platform: "openclaw" }, "playbook/t.md")).toThrow(Error);
  });
});

function runGuide(fixture: Fixture, args: string[], overrides?: RunOverrides): Promise<RunResult> {
  return runAligndev(fixture, ["guide", ...args], overrides);
}
