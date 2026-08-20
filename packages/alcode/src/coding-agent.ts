import { createClaudeAdapter } from "./claude-agent.js";
import { createCodexAdapter } from "./codex-agent.js";
import type { AgentAdapter } from "./run-agent.js";

export const CODING_AGENTS = ["claude", "codex"] as const;

export type CodingAgent = (typeof CODING_AGENTS)[number];

export function resolveCodingAgent(env: NodeJS.ProcessEnv): CodingAgent {
  const value = env.ALIGNFIRST_CODE_AGENT;
  if (value === undefined || value === "") {
    throw new Error(
      `Error: ALIGNFIRST_CODE_AGENT is required; accepted values: ${CODING_AGENTS.join(", ")}.`,
    );
  }
  if ((CODING_AGENTS as readonly string[]).includes(value)) return value as CodingAgent;
  throw new Error(
    `Error: invalid ALIGNFIRST_CODE_AGENT value ${JSON.stringify(value)}; accepted values: ` +
      `${CODING_AGENTS.join(", ")}.`,
  );
}

export function createAgentAdapter(agent: CodingAgent): AgentAdapter {
  return agent === "claude" ? createClaudeAdapter() : createCodexAdapter();
}
