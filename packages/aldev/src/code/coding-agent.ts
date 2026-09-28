import { createClaudeAdapter } from "./claude-agent.js";
import { createCodexAdapter } from "./codex-agent.js";
import type { AgentAdapter } from "./run-agent.js";

export const CODING_AGENTS = ["claude", "codex"] as const;

export type CodingAgent = (typeof CODING_AGENTS)[number];

export function createAgentAdapter(agent: CodingAgent): AgentAdapter {
  return agent === "claude" ? createClaudeAdapter() : createCodexAdapter();
}
