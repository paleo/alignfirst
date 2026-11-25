import type { CodingAgent } from "./coding-agent.js";

// What each harness gives the commands it runs. Detection and the child environment read the same
// table, so every detection marker is stripped.
export const HARNESS_ENVIRONMENTS: Record<CodingAgent, HarnessEnvironment> = {
  claude: {
    markers: [{ name: "CLAUDECODE", value: "1" }],
    sessionVariables: [
      "AI_AGENT",
      "CLAUDE_CODE_SESSION_ID",
      "CLAUDE_CODE_CHILD_SESSION",
      "CLAUDE_CODE_SESSION_ATTENDED",
      "CLAUDE_PID",
      "CLAUDE_EFFORT",
      "CLAUDE_CODE_ENTRYPOINT",
      "CLAUDE_CODE_EXECPATH",
      "CLAUDE_CODE_MESSAGING_SOCKET",
      "CLAUDE_CODE_MESSAGING_TOKEN",
      "CLAUDE_CODE_LAUNCHED_BY_SESSION_IDS",
      "CLAUDE_CODE_CHILD_NOTES_DIR",
      "CLAUDE_CODE_STARTER_MAY_HOLD_CONNECTOR_FILE",
      "CLAUDE_CODE_BRIDGE_SESSION_ID",
      "CLAUDE_CODE_HOST_WORKTREE",
      "CLAUDE_CODE_HOST_WORKTREE_FENCE",
      "CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS",
      "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING",
    ],
  },
  codex: {
    markers: [{ name: "CODEX_THREAD_ID" }],
    sessionVariables: [
      "CODEX_SESSION_ID",
      "CODEX_CI",
      "CODEX_SANDBOX_NETWORK_DISABLED",
      "CODEX_TOOL_CALL_ID",
      "CODEX_VERSION",
    ],
  },
  pi: {
    markers: [
      { name: "PI_CODING_AGENT", value: "true" },
      { name: "AI_AGENT", value: "pi" },
    ],
    sessionVariables: [
      "PI_SESSION_ID",
      "PI_SESSION_FILE",
      "PI_PROVIDER",
      "PI_MODEL",
      "PI_REASONING_LEVEL",
    ],
  },
  agy: {
    markers: [{ name: "ANTIGRAVITY_AGENT", value: "1" }],
    sessionVariables: [
      "ANTIGRAVITY_AGENTAPI_EXE",
      "ANTIGRAVITY_APP_DATA_DIR",
      "ANTIGRAVITY_CONVERSATION_ID",
      "ANTIGRAVITY_CSRF_TOKEN",
      "ANTIGRAVITY_LS_ADDRESS",
      "ANTIGRAVITY_LS_VERSION",
      "ANTIGRAVITY_PROJECT_ID",
      "ANTIGRAVITY_SOURCE_METADATA",
      "ANTIGRAVITY_TRAJECTORY_ID",
    ],
  },
};

export interface HarnessEnvironment {
  // One matching marker identifies a session of the harness.
  markers: readonly EnvironmentMarker[];
  // What the harness gives the commands it runs, besides its markers.
  sessionVariables: readonly string[];
}

export interface EnvironmentMarker {
  name: string;
  // Absent: any nonempty value matches.
  value?: string;
}
