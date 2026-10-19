import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig, resolveCodeConfig } from "../../packages/aligndev/dist/config.js";
import {
  buildCodingAgentSettings,
  type CodingAgentEnvironment,
  HARNESS_PROFILE,
  PI_CONTRACT_MODEL,
  readConfiguredAgent,
} from "../scripts/coding-agent-settings.ts";

const WRITER = fileURLToPath(new URL("../scripts/write-coding-agent-settings.ts", import.meta.url));

for (const agent of ["claude", "codex", "pi"] as const) {
  test(`${agent} settings use an explicit complete profile and pass the real config resolver`, () => {
    const home = mkdtempSync(join(tmpdir(), "harness-settings-"));
    try {
      const settings = buildCodingAgentSettings({ CODING_AGENT: agent });
      assert.deepEqual(settings, {
        platform: "openclaw",
        projectsRoot: "/home/assistant/projects",
        code: { profile: HARNESS_PROFILE, profiles: { [HARNESS_PROFILE]: { agent } } },
      });
      const path = join(home, ".alignfirst/aligndev.settings.json");
      mkdirSync(dirname(path));
      writeFileSync(path, JSON.stringify(settings));
      const effective = resolveCodeConfig(loadConfig(home), {});
      assert.equal(effective.profile, HARNESS_PROFILE);
      assert.equal(effective.agent, agent);
      assert.equal(effective.defaultModel, undefined);
      assert.deepEqual(effective.models, undefined);
      assert.deepEqual(readdirSync(home), [".alignfirst"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test(`${agent} model lists trim blanks and replace accepted names without a default`, () => {
    const env = Object.freeze({
      CODING_AGENT: agent,
      CODING_AGENT_MODELS: " , first, , second , ",
    });
    const profile = buildCodingAgentSettings(env).code.profiles[HARNESS_PROFILE];
    assert.deepEqual(profile, { agent, models: ["first", "second"] });
    assert.deepEqual(
      buildCodingAgentSettings({ CODING_AGENT: agent, CODING_AGENT_MODELS: ", ," }).code.profiles[
        HARNESS_PROFILE
      ],
      { agent },
    );
  });
}

for (const selector of [undefined, "", "Pi", " pi ", "openai", "invalid"]) {
  test(`rejects missing or invalid coding selector ${JSON.stringify(selector)}`, () => {
    const env = { CODING_AGENT: selector };
    assert.throws(() => buildCodingAgentSettings(env), /CODING_AGENT must be claude, codex or pi/u);
    assert.throws(() => readConfiguredAgent(env), /CODING_AGENT must be/u);
  });
}

test("settings construction reads only selectors, never credentials, HOME or conversation providers", () => {
  const env: CodingAgentEnvironment = new Proxy(
    { CODING_AGENT: "pi" },
    {
      get(target, key) {
        if (key === "CODING_AGENT_MODELS") return PI_CONTRACT_MODEL;
        if (key === "CODING_AGENT") return target.CODING_AGENT;
        throw new Error(`unexpected environment read: ${String(key)}`);
      },
    },
  );
  assert.deepEqual(buildCodingAgentSettings(env).code.profiles[HARNESS_PROFILE], {
    agent: "pi",
    models: [PI_CONTRACT_MODEL],
  });
});

test("thin writer writes only the explicit temporary destination with no external commands", () => {
  const home = mkdtempSync(join(tmpdir(), "harness-settings-writer-"));
  try {
    const destination = join(home, "output/settings.json");
    const run = spawnSync(process.execPath, [WRITER, destination], {
      env: { HOME: home, PATH: "", CODING_AGENT: "pi", CODING_AGENT_MODELS: PI_CONTRACT_MODEL },
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(
      JSON.parse(readFileSync(destination, "utf8")),
      buildCodingAgentSettings({
        CODING_AGENT: "pi",
        CODING_AGENT_MODELS: PI_CONTRACT_MODEL,
      }),
    );
    assert.deepEqual(readdirSync(home), ["output"]);
    for (const args of [[], [destination, "extra"]]) {
      const invalid = spawnSync(process.execPath, [WRITER, ...args], {
        env: { HOME: home, PATH: "", CODING_AGENT: "pi" },
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 64 * 1024,
      });
      assert.notEqual(invalid.status, 0);
      assert.match(invalid.stderr, /Usage:/u);
    }
    const invalid = spawnSync(process.execPath, [WRITER, join(home, "must-not-exist/settings")], {
      env: { HOME: home, PATH: "" },
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
    assert.notEqual(invalid.status, 0);
    assert.deepEqual(readdirSync(home), ["output"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
