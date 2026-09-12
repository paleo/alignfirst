import type { ThreadObservation } from "../../scripts/inspect-thread.ts";
import type { ScenarioContext } from "@paleo/openclaw-test";
import { setTimeout } from "node:timers/promises";

const INSPECT_SESSION = "/opt/alignfirst/alignfirst-developer-tests/scripts/inspect-thread.ts";

export async function waitForThreadSettlement(
  ctx: ScenarioContext,
  sessionKey: string,
  launchId?: string,
): Promise<void> {
  const deadline = Date.now() + 180_000;
  let stableCount = -1;
  let stableSince = Date.now();
  let last: ThreadObservation | undefined;
  while (Date.now() < deadline) {
    const result = await ctx.execInGateway([
      "node",
      INSPECT_SESSION,
      sessionKey,
      ...(launchId === undefined ? [] : [launchId]),
    ]);
    if (result.exitCode !== 0) throw new Error(`Session inspection failed: ${result.stderr}`);
    const observation: ThreadObservation = JSON.parse(result.stdout);
    last = observation;
    // The chained event requests a heartbeat and returns. Its process may exit before the report,
    // so observe process exit and thread settlement independently.
    const completionObserved =
      launchId === undefined ||
      (observation.backgroundResultObserved === true && observation.processExited === true);
    if (
      !completionObserved ||
      observation.terminalCount === 0 ||
      observation.messageCount !== stableCount ||
      observation.openTurn
    ) {
      stableCount = observation.messageCount;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= 3_000) {
      ctx.log(`thread settled: ${JSON.stringify(observation)}`);
      return;
    }
    await setTimeout(1_000);
  }
  throw new Error(`Thread did not settle: ${JSON.stringify(last)}`);
}
