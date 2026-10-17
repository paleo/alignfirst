import { createClaudeAdapter } from "./claude-agent.js";
import { createCodexAdapter } from "./codex-agent.js";
import { createPiAdapter } from "./pi-agent.js";
import type { AgentAdapter } from "./run-agent.js";

export const CODING_AGENTS = ["claude", "codex", "pi"] as const;

export type CodingAgent = (typeof CODING_AGENTS)[number];

export function createAgentAdapter(agent: CodingAgent): AgentAdapter {
  switch (agent) {
    case "claude":
      return createClaudeAdapter();
    case "codex":
      return createCodexAdapter();
    case "pi":
      return createPiAdapter();
  }
}

// Host markers select the child only when code.agent is absent.
export function detectCodingAgents(env: NodeJS.ProcessEnv): CodingAgent[] {
  const detected: CodingAgent[] = [];
  if (env.CLAUDECODE === "1") detected.push("claude");
  if (env.CODEX_THREAD_ID !== undefined && env.CODEX_THREAD_ID !== "") detected.push("codex");
  if (env.PI_CODING_AGENT === "true" || env.AI_AGENT === "pi") detected.push("pi");
  return detected;
}
