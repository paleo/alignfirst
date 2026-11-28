import { describe, expect, it } from "vitest";

import { resolveAssistantHarness } from "../../src/assistant-harness.js";
import { CODING_AGENTS, detectCodingAgents } from "../../src/code/coding-agent.js";
import { buildAgentEnv } from "../../src/code/run-agent.js";

const CHILD_MARKERS = {
  claude: { CLAUDECODE: "1" },
  codex: { CODEX_THREAD_ID: "codex-thread" },
  pi: { PI_CODING_AGENT: "true" },
  agy: { ANTIGRAVITY_AGENT: "1" },
};

describe("OpenClaw harness session isolation", () => {
  it.each(CODING_AGENTS)("gives a child of an OpenClaw assistant only the %s session", (child) => {
    const built = buildAgentEnv({ HOME: "/home/user", OPENCLAW_SHELL: "exec" }, []);
    const childEnv = { ...built, ...CHILD_MARKERS[child] };
    expect(detectCodingAgents(childEnv)).toEqual([child]);
    expect(resolveAssistantHarness(childEnv).harness).toBe(child);
  });
});
