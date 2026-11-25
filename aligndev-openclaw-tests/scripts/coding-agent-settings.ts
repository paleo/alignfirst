export const MOCK_AGENT_PROFILE = "mock-agent";
export const PI_CONTRACT_MODEL = "openai/gpt-6.1-terra";

export type CodingAgent = "claude" | "codex" | "pi";

export interface CodingAgentEnvironment {
  CODING_AGENT?: string;
  CODING_AGENT_MODELS?: string;
}

export interface MockAgentSettings {
  projectsRoot: string;
  code: {
    profiles: {
      openclaw: { harness: "openclaw"; defaultAgentProfile: string };
      [MOCK_AGENT_PROFILE]: { harness: CodingAgent; models?: string[] };
    };
  };
}

export function buildCodingAgentSettings(env: CodingAgentEnvironment): MockAgentSettings {
  const agent = readConfiguredAgent(env);
  const models = (env.CODING_AGENT_MODELS ?? "")
    .split(",")
    .map((model) => model.trim())
    .filter((model) => model !== "");
  return {
    projectsRoot: "/home/assistant/projects",
    code: {
      profiles: {
        openclaw: { harness: "openclaw", defaultAgentProfile: MOCK_AGENT_PROFILE },
        [MOCK_AGENT_PROFILE]: { harness: agent, ...(models.length > 0 ? { models } : {}) },
      },
    },
  };
}

export function readConfiguredAgent(env: CodingAgentEnvironment): CodingAgent {
  const agent = env.CODING_AGENT;
  if (agent === "claude" || agent === "codex" || agent === "pi") return agent;
  throw new Error(`CODING_AGENT must be claude, codex or pi, got ${JSON.stringify(agent)}`);
}
