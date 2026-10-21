import type { ScenarioContext } from "@alignfirst/openclaw-test";
import { runLightweightApprovalCase } from "./_lib/lightweight-flow.ts";

export default async function trackedPlansApproval(ctx: ScenarioContext): Promise<void> {
  await runLightweightApprovalCase(ctx, "tracked");
}
