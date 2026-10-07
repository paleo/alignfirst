import { createClaudeAdapter } from "./claude-agent.js";
import { createCodexAdapter } from "./codex-agent.js";
import type { AgentAdapter } from "./run-agent.js";

export const CODING_AGENTS = ["claude", "codex"] as const;

export type CodingAgent = (typeof CODING_AGENTS)[number];

export function createAgentAdapter(agent: CodingAgent): AgentAdapter {
  return agent === "claude" ? createClaudeAdapter() : createCodexAdapter();
}

// Each coding agent marks the commands it runs: Claude Code sets `CLAUDECODE=1` (documented), and
// Codex sets `CODEX_THREAD_ID`.
export function detectCodingAgents(env: NodeJS.ProcessEnv): CodingAgent[] {
  const detected: CodingAgent[] = [];
  if (env.CLAUDECODE === "1") detected.push("claude");
  if (env.CODEX_THREAD_ID !== undefined && env.CODEX_THREAD_ID !== "") detected.push("codex");
  return detected;
}
