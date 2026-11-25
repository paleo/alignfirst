import { type CodingAgent, detectCodingAgents } from "./code/coding-agent.js";

export const HARNESSES = ["claude", "codex", "pi", "agy", "openclaw"] as const;
export const PLATFORMS = ["openclaw", "codingAgent"] as const;
export const ASSISTANT_HARNESS_VARIABLE = "ALIGNDEV_ASSISTANT_HARNESS";

// The software that runs a session: the assistant's, or the coding agent's.
export type Harness = (typeof HARNESSES)[number];

// The guide's block selector, derived from the assistant's harness.
export type Platform = (typeof PLATFORMS)[number];

// `detected` explains an unrecognized harness in diagnostics.
export interface AssistantHarness {
  harness: Harness | undefined;
  detected: CodingAgent[];
}

// An agent launched by `aligndev code` from OpenClaw inherits OPENCLAW_SHELL: detection wins.
export function resolveAssistantHarness(env: NodeJS.ProcessEnv): AssistantHarness {
  const requested = env[ASSISTANT_HARNESS_VARIABLE];
  const detected = detectCodingAgents(env);
  if (requested !== undefined && requested !== "") {
    if (!isHarness(requested)) {
      throw new Error(
        `Error: invalid ${ASSISTANT_HARNESS_VARIABLE}: use ${HARNESSES.join(", ")}, or leave it unset.`,
      );
    }
    return { harness: requested, detected };
  }
  if (detected.length === 1) return { harness: detected[0], detected };
  if (detected.length === 0 && env.OPENCLAW_SHELL === "exec") {
    return { harness: "openclaw", detected };
  }
  return { harness: undefined, detected };
}

function isHarness(value: string): value is Harness {
  return (HARNESSES as readonly string[]).includes(value);
}

export function platformOf(harness: Harness | undefined): Platform {
  return harness === "openclaw" ? "openclaw" : "codingAgent";
}
