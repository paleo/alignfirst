import type { ScenarioContext } from "@paleo/openclaw-test";
import { escapeRe } from "./_lib/common-constants.ts";
import { setupAlprojectMock } from "./_lib/mock-alproject.ts";
import { expectNoProtocolDelegation, setupCodingAgentMock } from "./_lib/mock-coding-agent.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import { LUMEN_PROJECT_PATH, NIMBUS_PROJECT_PATH } from "./_lib/project-fixtures.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";
import { bootstrapThreadFromChannel } from "./_lib/thread-bootstrap.ts";

const TASK = "Rafraîchis les branches de base de nimbus et lumen.";

export default async function multiProjectHandoff(ctx: ScenarioContext): Promise<void> {
  await resetFixtures(ctx);
  setupAlprojectMock(ctx);
  const codingAgent = setupCodingAgentMock(ctx, {
    defaultResult: "Base branch refreshed from origin/main. Dependencies are current.",
  });
  setupGhMock(ctx);

  const starter = await bootstrapThreadFromChannel(ctx, {
    text: TASK,
    codingAgent,
  });

  ctx.assertRegex(starter.match.text, /\bnimbus\b/iu, "starter carries nimbus");
  ctx.assertRegex(starter.match.text, /\blumen\b/iu, "starter carries lumen");
  ctx.assertRegex(
    starter.match.text,
    new RegExp(escapeRe(NIMBUS_PROJECT_PATH), "u"),
    "starter carries the nimbus path",
  );
  ctx.assertRegex(
    starter.match.text,
    new RegExp(escapeRe(LUMEN_PROJECT_PATH), "u"),
    "starter carries the lumen path",
  );
  await ctx.judgeLLM({
    attachTo: starter.entry,
    message: starter.match.text,
    rubric:
      "A thread-opening handoff for refreshing the base branches of both nimbus and lumen. It " +
      "does not ask the user to choose one main project, supply a ticket, or send a mechanical " +
      "follow-up. It states that the complete work is starting in the working session.",
    label: "multi-project-explicit-working-session",
  });
  await expectBaseRefreshDelegation(ctx, codingAgent, "nimbus", NIMBUS_PROJECT_PATH);
  await expectBaseRefreshDelegation(ctx, codingAgent, "lumen", LUMEN_PROJECT_PATH);

  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}

async function expectBaseRefreshDelegation(
  ctx: ScenarioContext,
  codingAgent: ReturnType<typeof setupCodingAgentMock>,
  project: string,
  projectPath: string,
): Promise<void> {
  const { call } = await expectNoProtocolDelegation(ctx, codingAgent, {
    matches: (candidate) => candidate.cwd.replace(/\/$/u, "") === projectPath,
    rubric:
      "A captured coding-agent CLI invocation. Judge only the prompt text (the last argv " +
      "element); CLI flags such as exec/--json/--sandbox are the runner's mechanics, not a " +
      `protocol. Pass when the prompt asks the coding agent, from the ${project} project, to ` +
      "refresh the base branch from its remote and perform any required dependency, build, or " +
      "migration refresh. Reject an AlignFirst protocol invocation in the prompt " +
      "(`Run the _spec_ protocol …` and similar).",
    label: `${project}-base-refresh-delegation`,
    timeoutMs: 300_000,
  });
  if (call.cwd.replace(/\/$/u, "") !== projectPath) {
    throw new Error(`${project} delegation ran from ${call.cwd}, expected ${projectPath}`);
  }
}
