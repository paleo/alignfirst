import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveAssistantHarness } from "../../src/assistant-harness.js";
import { main } from "../../src/cli.js";
import { loadConfig, resolveCodeConfig } from "../../src/config.js";
import { makeSink, writeSettings } from "../helpers.js";
import { writeAlignfirstStub } from "../stand-ins.js";

const OPENCLAW = { OPENCLAW_SHELL: "exec" };
const homes: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function makeHome(config?: object): string {
  const home = mkdtempSync(join(tmpdir(), "aligndev-openclaw-config-"));
  homes.push(home);
  if (config !== undefined) writeSettings(home, config);
  return home;
}

describe("OpenClaw settings", () => {
  it("ignores the retired platform setting with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    loadConfig(makeHome({ platform: "openclaw" }), "alignfirst");
    expect(warn).toHaveBeenCalledOnce();
  });

  it("reads a legacy profile agent openclaw as its harness", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const legacy = { agent: "openclaw", defaultAgentProfile: "x" };
    const home = makeHome({ code: { profiles: { x: { harness: "pi" }, legacy } } });
    expect(loadConfig(home, "alignfirst").code.profiles?.legacy).toEqual({
      harness: "openclaw",
      defaultAgentProfile: "x",
    });
  });

  it("accepts an openclaw profile with its own keys and warns on unknown ones", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const openclaw = { harness: "openclaw", defaultAgentProfile: "work", disabled: false };
    const home = makeHome({
      code: { profiles: { assistant: { ...openclaw, stale: 1 }, work: { harness: "pi" } } },
    });
    expect(loadConfig(home, "alignfirst").code.profiles?.assistant).toEqual(openclaw);
    expect(warn).toHaveBeenCalledOnce();
  });

  it.each([
    {},
    { default: true },
    { configDir: null },
    { models: [] },
    { defaultEffort: "high" },
    { env: {} },
    { quota: { source: "none" } },
  ])(
    "rejects an openclaw profile without defaultAgentProfile or with coding-agent keys %j",
    (extra) => {
      const defaultAgentProfile =
        Object.keys(extra).length === 0 ? {} : { defaultAgentProfile: "x" };
      const home = makeHome({
        code: {
          profiles: { assistant: { harness: "openclaw", ...defaultAgentProfile, ...extra } },
        },
      });
      expect(() => loadConfig(home, "alignfirst")).toThrow(Error);
    },
  );
});

describe("OpenClaw assistant's harness", () => {
  it.each([
    [{ ALIGNDEV_ASSISTANT_HARNESS: "pi", CLAUDECODE: "1", ...OPENCLAW }, "pi"],
    [{ ANTIGRAVITY_AGENT: "1", ...OPENCLAW }, "agy"],
    [OPENCLAW, "openclaw"],
    [{ CLAUDECODE: "1", AI_AGENT: "pi", ...OPENCLAW }, undefined],
    [{ OPENCLAW_SHELL: "other" }, undefined],
  ])("resolves %j to %s", (env, harness) => {
    expect(resolveAssistantHarness(env).harness).toBe(harness);
  });
});

describe("OpenClaw profile resolution", () => {
  it("delegates an openclaw session to its openclaw profile, else to the fallback", () => {
    const home = makeHome({
      code: {
        fallbackProfile: "fallback",
        profiles: {
          assistant: { harness: "openclaw", defaultAgentProfile: "service" },
          service: { harness: "pi" },
          fallback: { harness: "claude" },
        },
      },
    });
    expect(resolveCodeConfig(loadConfig(home, "alignfirst"), OPENCLAW).profile).toBe("service");
    const config = loadConfig(home, "alignfirst");
    const disabled = config.code.profiles?.assistant;
    if (disabled === undefined) throw new Error("missing fixture profile");
    disabled.disabled = true;
    expect(resolveCodeConfig(config, OPENCLAW).profile).toBe("fallback");
  });

  it("requires code.fallbackProfile or --profile without an openclaw profile", () => {
    const home = makeHome({ code: { profiles: { only: { harness: "pi" } } } });
    expect(() => resolveCodeConfig(loadConfig(home, "alignfirst"), OPENCLAW)).toThrow(Error);
  });

  it("fails a reference to an openclaw profile", () => {
    const config = loadConfig(
      makeHome({
        code: {
          profiles: {
            ok: { harness: "claude" },
            assistant: { harness: "openclaw", defaultAgentProfile: "ok" },
          },
        },
      }),
      "alignfirst",
    );
    expect(() => resolveCodeConfig(config, {}, { explicit: "assistant" })).toThrow(Error);
  });

  it("rejects two enabled openclaw profiles even with a named selection", () => {
    const profiles = {
      ok: { harness: "claude" },
      first: { harness: "openclaw", defaultAgentProfile: "ok" },
      second: { harness: "openclaw", defaultAgentProfile: "gone", disabled: true },
    };
    const home = makeHome({ code: { profiles } });
    expect(resolveCodeConfig(loadConfig(home, "alignfirst"), {}, { explicit: "ok" }).profile).toBe(
      "ok",
    );
    writeSettings(home, {
      code: {
        profiles: { ...profiles, second: { harness: "openclaw", defaultAgentProfile: "ok" } },
      },
    });
    expect(() => resolveCodeConfig(loadConfig(home, "alignfirst"), {}, { explicit: "ok" })).toThrow(
      Error,
    );
  });

  it("rejects --profile on the project guide", async () => {
    const home = makeHome({
      projectsRoot: "~/projects",
      code: { fallbackProfile: "x", profiles: { x: { harness: "pi" } } },
    });
    mkdirSync(join(home, "projects"));
    const run = (args: string[]) =>
      main({
        argv: ["node", "aligndev", ...args],
        cwd: home,
        home,
        env: { HOME: home, ALIGNDEV_ASSISTANT_HARNESS: "openclaw" },
        alignfirstCommand: writeAlignfirstStub(home, home).command,
        stdout: makeSink(),
        stderr: makeSink(),
      });
    expect(await run(["guide", "project"])).toBe(0);
    expect(await run(["guide", "project", "--profile", "x"])).toBe(1);
  });
});
