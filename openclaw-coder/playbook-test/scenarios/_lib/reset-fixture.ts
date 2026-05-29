import type { ScenarioContext } from "@paleo/openclaw-test";

export async function resetFixtures(ctx: ScenarioContext): Promise<void> {
  const r = await ctx.execInGateway(["/opt/openclaw-test/scripts/reset-fixture.mjs"], {
    timeoutMs: 60_000,
  });
  if (r.exitCode !== 0) {
    throw new Error(
      `fixture reset failed (exit ${r.exitCode}):\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`,
    );
  }
}
