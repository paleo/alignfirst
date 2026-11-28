import { describe, expect, it } from "vitest";

import { resolveAssistantHarness } from "../../src/assistant-harness.js";
import {
  CODING_AGENTS,
  type CodingAgent,
  detectCodingAgents,
} from "../../src/code/coding-agent.js";
import { buildAgentEnv } from "../../src/code/run-agent.js";

// What each harness really gives the commands it runs, observed with the installed CLIs. Written by
// hand, independently of the strip table, to catch a variable missing from it.
const EXPORTS: Record<CodingAgent, Record<string, string>> = {
  claude: {
    CLAUDECODE: "1",
    CLAUDE_CODE_SESSION_ID: "claude-session",
    CLAUDE_CODE_CHILD_SESSION: "1",
    CLAUDE_CODE_SESSION_ATTENDED: "1",
    CLAUDE_PID: "4242",
    CLAUDE_CODE_LAUNCHED_BY_SESSION_IDS: "claude-parent",
    CLAUDE_CODE_CHILD_NOTES_DIR: "/tmp/claude-notes",
    CLAUDE_CODE_STARTER_MAY_HOLD_CONNECTOR_FILE: "1",
    AI_AGENT: "claude-code_2-1-330_agent",
    CLAUDE_EFFORT: "high",
    CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
    CLAUDE_CODE_EXECPATH: "/opt/claude/claude",
    CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/claude.sock",
    CLAUDE_CODE_MESSAGING_TOKEN: "claude-token",
    CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
    CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: "true",
  },
  codex: {
    CODEX_THREAD_ID: "codex-thread",
    CODEX_SESSION_ID: "codex-session",
    CODEX_CI: "1",
    CODEX_SANDBOX_NETWORK_DISABLED: "1",
    CODEX_TOOL_CALL_ID: "call_1",
    CODEX_VERSION: "0.166.0",
  },
  pi: {
    PI_CODING_AGENT: "true",
    AI_AGENT: "pi",
    PI_SESSION_ID: "pi-session",
    PI_SESSION_FILE: "/tmp/pi-session.jsonl",
    PI_PROVIDER: "openai",
    PI_MODEL: "luna",
    PI_REASONING_LEVEL: "high",
  },
  agy: {
    ANTIGRAVITY_AGENT: "1",
    ANTIGRAVITY_AGENTAPI_EXE: "/opt/agy/agentapi",
    ANTIGRAVITY_APP_DATA_DIR: "/home/user/.gemini/antigravity-cli",
    ANTIGRAVITY_CONVERSATION_ID: "agy-conversation",
    ANTIGRAVITY_CSRF_TOKEN: "agy-token",
    ANTIGRAVITY_LS_ADDRESS: "127.0.0.1:4100",
    ANTIGRAVITY_LS_VERSION: "1.5.17",
    ANTIGRAVITY_PROJECT_ID: "agy-project",
    ANTIGRAVITY_SOURCE_METADATA: "{}",
    ANTIGRAVITY_TRAJECTORY_ID: "agy-trajectory",
  },
};
const BASE = { HOME: "/home/user", LANG: "C.UTF-8" };

describe("harness session isolation", () => {
  it("strips every assistant export and keeps only the child's own session", () => {
    for (const assistant of [...CODING_AGENTS, undefined]) {
      const exports = assistant === undefined ? {} : EXPORTS[assistant];
      const built = buildAgentEnv({ ...BASE, ...exports }, []);
      expect(built).toEqual(BASE);
      for (const child of CODING_AGENTS) {
        const childEnv = { ...built, ...EXPORTS[child] };
        expect(detectCodingAgents(childEnv)).toEqual([child]);
        expect(resolveAssistantHarness(childEnv).harness).toBe(child);
      }
    }
  });

  it.each([
    ["PI_CODING_AGENT alone", { PI_CODING_AGENT: "true" }],
    ["AI_AGENT alone", { AI_AGENT: "pi" }],
  ])("detects pi from %s and strips it", (_name, exports) => {
    expect(detectCodingAgents(exports)).toEqual(["pi"]);
    expect(buildAgentEnv(exports, [])).toEqual({});
  });

  it("strips harness markers whatever their values and keeps native settings", () => {
    const settings = {
      CLAUDE_CODE_USE_BEDROCK: "1",
      PI_CODING_AGENT_DIR: "/config",
      PI_CODING_AGENT_SESSION_DIR: "/sessions",
      OPENAI_API_KEY: "credential",
    };
    const caller = { AI_AGENT: "other", PI_CODING_AGENT: "false", CLAUDECODE: "0", ...settings };
    expect(buildAgentEnv(caller, [])).toEqual(settings);
  });

  it("builds each successive child from the unchanged caller environment", () => {
    const caller = { ...BASE, ...EXPORTS.claude };
    const before = { ...caller };
    buildAgentEnv(caller, [], { CODEX_HOME: "/codex" }, { CODEX_REQUIRED: "1" });
    expect(caller).toEqual(before);
    expect(buildAgentEnv(caller, [], { PI_CODING_AGENT_DIR: "/pi" })).toEqual(
      buildAgentEnv({ ...before }, [], { PI_CODING_AGENT_DIR: "/pi" }),
    );
  });

  it("detects only the grandchild under nested sessions", () => {
    const childEnv = { ...buildAgentEnv({ ...BASE, ...EXPORTS.claude }, []), ...EXPORTS.codex };
    const grandchildEnv = { ...buildAgentEnv(childEnv, []), ...EXPORTS.pi };
    expect(detectCodingAgents(grandchildEnv)).toEqual(["pi"]);
  });

  it("passes trace and host-app variables through unless the profile unsets them", () => {
    const kept = {
      TRACEPARENT: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
      TRACESTATE: "vendor=value",
      PASEO_AGENT_ID: "paseo-agent",
      PASEO_WORKSPACE_ID: "paseo-workspace",
      PASEO_AGENT_CWD: "/srv/project",
    };
    const caller = { ...BASE, ...EXPORTS.claude, ...kept };
    expect(buildAgentEnv(caller, [])).toMatchObject(kept);
    const unset = buildAgentEnv(caller, Object.keys(kept));
    expect(Object.keys(unset).filter((name) => name in kept)).toEqual([]);
  });

  // A coding agent launched from an OpenClaw exec inherits OPENCLAW_SHELL.
  it("keeps OPENCLAW_SHELL for the child while the detected coding agent wins", () => {
    const childEnv = {
      ...buildAgentEnv({ ...BASE, OPENCLAW_SHELL: "exec", ALIGNDEV_ASSISTANT_HARNESS: "x" }, []),
      ...EXPORTS.codex,
    };
    expect(childEnv.OPENCLAW_SHELL).toBe("exec");
    expect(childEnv.ALIGNDEV_ASSISTANT_HARNESS).toBeUndefined();
    expect(resolveAssistantHarness(childEnv).harness).toBe("codex");
  });
});
