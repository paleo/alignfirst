import type { ScenarioContext } from "@paleo/openclaw-test";

/**
 * Silent `gh` stub. The agent may invoke `gh` incidentally; absorbing the call
 * here keeps the sandbox boundary intact. Scenarios that need richer GitHub
 * behaviour will extend this later.
 */
export function setupGhMock(ctx: ScenarioContext): void {
  ctx.mockCli("gh", async () => 0);
}
