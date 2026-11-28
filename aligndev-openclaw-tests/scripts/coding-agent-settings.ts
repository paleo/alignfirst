export const MOCK_AGENT_PROFILE = "mock-agent";
// The mocked Pi child accepts any fixed selector, so the fixture names no real model.
export const PI_CONTRACT_MODEL = "mock/contract-model";

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
  const models = declaredModels(agent, env.CODING_AGENT_MODELS ?? "");
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

// A Pi profile accepts only the models it declares: without a list, it declares the fixture model.
function declaredModels(agent: CodingAgent, list: string): string[] {
  const models = list
    .split(",")
    .map((model) => model.trim())
    .filter((model) => model !== "");
  return models.length === 0 && agent === "pi" ? [PI_CONTRACT_MODEL] : models;
}

export function readConfiguredAgent(env: CodingAgentEnvironment): CodingAgent {
  const agent = env.CODING_AGENT;
  if (agent === "claude" || agent === "codex" || agent === "pi") return agent;
  throw new Error(`CODING_AGENT must be claude, codex or pi, got ${JSON.stringify(agent)}`);
}
