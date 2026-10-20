export const HARNESS_PROFILE = "harness";
export const PI_CONTRACT_MODEL = "openai/gpt-5.6-terra";

export type CodingAgent = "claude" | "codex" | "pi";

export interface CodingAgentEnvironment {
  CODING_AGENT?: string;
  CODING_AGENT_MODELS?: string;
}

export interface HarnessSettings {
  platform: "openclaw";
  projectsRoot: string;
  code: {
    profile: string;
    profiles: Record<string, { agent: CodingAgent; models?: string[] }>;
  };
}

export function buildCodingAgentSettings(env: CodingAgentEnvironment): HarnessSettings {
  const agent = readConfiguredAgent(env);
  const models = (env.CODING_AGENT_MODELS ?? "")
    .split(",")
    .map((model) => model.trim())
    .filter((model) => model !== "");
  return {
    platform: "openclaw",
    projectsRoot: "/home/assistant/projects",
    code: {
      profile: HARNESS_PROFILE,
      profiles: { [HARNESS_PROFILE]: { agent, ...(models.length > 0 ? { models } : {}) } },
    },
  };
}

export function readConfiguredAgent(env: CodingAgentEnvironment): CodingAgent {
  const agent = env.CODING_AGENT;
  if (agent === "claude" || agent === "codex" || agent === "pi") return agent;
  throw new Error(`CODING_AGENT must be claude, codex or pi, got ${JSON.stringify(agent)}`);
}
