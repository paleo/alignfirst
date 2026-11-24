import type { CodingAgent } from "./coding-agent.js";

const BUILT_IN_EFFORTS: Readonly<Record<CodingAgent, readonly string[]>> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["low", "medium", "high", "xhigh", "max", "ultra"],
  pi: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
};

export function resolveEfforts(
  harness: CodingAgent,
  override: readonly string[] | undefined,
): readonly string[] {
  return override !== undefined && override.length > 0 ? override : BUILT_IN_EFFORTS[harness];
}
