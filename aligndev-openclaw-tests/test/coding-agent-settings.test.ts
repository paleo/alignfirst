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
  MOCK_AGENT_PROFILE,
  PI_CONTRACT_MODEL,
} from "../scripts/coding-agent-settings.ts";

const WRITER = fileURLToPath(new URL("../scripts/write-coding-agent-settings.ts", import.meta.url));

test("each agent delegates from the openclaw profile through the real config resolver", () => {
  for (const agent of ["claude", "codex", "pi"] as const) {
    const home = mkdtempSync(join(tmpdir(), "harness-settings-"));
    try {
      const settings = buildCodingAgentSettings({ CODING_AGENT: agent });
      assert.deepEqual(settings, {
        projectsRoot: "/home/assistant/projects",
        code: {
          profiles: {
            openclaw: { harness: "openclaw", defaultAgentProfile: MOCK_AGENT_PROFILE },
            [MOCK_AGENT_PROFILE]: { harness: agent },
          },
        },
      });
      const path = join(home, ".alignfirst/aligndev.settings.json");
      mkdirSync(dirname(path));
      writeFileSync(path, JSON.stringify(settings));
      const effective = resolveCodeConfig(loadConfig(home, "alignfirst"), {
        OPENCLAW_SHELL: "exec",
      });
      assert.equal(effective.profile, MOCK_AGENT_PROFILE, agent);
      assert.equal(effective.harness, agent);
      assert.equal(effective.defaultModel, undefined, agent);
      assert.deepEqual(effective.models, undefined, agent);
      assert.deepEqual(readdirSync(home), [".alignfirst"], agent);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test("model lists trim blanks and replace accepted names without a default", () => {
  for (const [models, expected] of [
    [" , first, , second , ", { harness: "codex", models: ["first", "second"] }],
    [", ,", { harness: "codex" }],
  ] as const) {
    const env = Object.freeze({ CODING_AGENT: "codex", CODING_AGENT_MODELS: models });
    assert.deepEqual(buildCodingAgentSettings(env).code.profiles[MOCK_AGENT_PROFILE], expected);
  }
});

test("rejects missing or invalid coding selectors", () => {
  for (const selector of [undefined, "", "Pi", " pi ", "openai"]) {
    assert.throws(
      () => buildCodingAgentSettings({ CODING_AGENT: selector }),
      Error,
      JSON.stringify(selector),
    );
  }
});

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
  assert.deepEqual(buildCodingAgentSettings(env).code.profiles[MOCK_AGENT_PROFILE], {
    harness: "pi",
    models: [PI_CONTRACT_MODEL],
  });
});

test("thin writer writes only the explicit temporary destination with no external commands", () => {
  const home = mkdtempSync(join(tmpdir(), "harness-settings-writer-"));
  try {
    const env = {
      HOME: home,
      PATH: "",
      CODING_AGENT: "pi",
      CODING_AGENT_MODELS: PI_CONTRACT_MODEL,
    };
    const destination = join(home, "output/settings.json");
    const run = runWriter([destination], env);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(
      JSON.parse(readFileSync(destination, "utf8")),
      buildCodingAgentSettings({ CODING_AGENT: "pi", CODING_AGENT_MODELS: PI_CONTRACT_MODEL }),
    );
    const rejected = runWriter([join(home, "must-not-exist/settings.json"), "extra"], env);
    assert.notEqual(rejected.status, 0);
    assert.deepEqual(readdirSync(home), ["output"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

function runWriter(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [WRITER, ...args], {
    env,
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  });
}
