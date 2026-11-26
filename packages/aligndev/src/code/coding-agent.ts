import { createAgyAdapter } from "./agy-agent.js";
import { createClaudeAdapter } from "./claude-agent.js";
import { createCodexAdapter } from "./codex-agent.js";
import { type EnvironmentMarker, HARNESS_ENVIRONMENTS } from "./harness-environment.js";
import { createPiAdapter } from "./pi-agent.js";
import type { AgentAdapter } from "./run-agent.js";

export const CODING_AGENTS = ["claude", "codex", "pi", "agy"] as const;

export const CODING_AGENT_NAMES: Readonly<Record<CodingAgent, string>> = {
  claude: "Claude Code",
  codex: "Codex",
  pi: "Pi",
  agy: "Antigravity",
};

export type CodingAgent = (typeof CODING_AGENTS)[number];

export function createAgentAdapter(agent: CodingAgent): AgentAdapter {
  switch (agent) {
    case "claude":
      return createClaudeAdapter();
    case "codex":
      return createCodexAdapter();
    case "pi":
      return createPiAdapter();
    case "agy":
      return createAgyAdapter();
  }
}

// The coding agents whose session runs this process; one gives the assistant's harness.
export function detectCodingAgents(env: NodeJS.ProcessEnv): CodingAgent[] {
  return CODING_AGENTS.filter((agent) =>
    HARNESS_ENVIRONMENTS[agent].markers.some((marker) => markerMatches(marker, env)),
  );
}

function markerMatches({ name, value }: EnvironmentMarker, env: NodeJS.ProcessEnv): boolean {
  const actual = env[name];
  if (actual === undefined || actual === "") return false;
  return value === undefined || actual === value;
}
