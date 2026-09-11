import { mkdir, writeFile } from "node:fs/promises";
import type { ScenarioContext } from "@paleo/openclaw-test";
import { assertBranchForTicket, waitForAnyWorktreeDir } from "./_lib/fixture-state.ts";
import { waitForProjectListing } from "./_lib/project-lifecycle.ts";
import { expectCodingDelegation, setupCodingAgentMock } from "./_lib/mock-coding-agent.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import { NIMBUS_PROJECT_PATH } from "./_lib/project-fixtures.ts";
import { waitForCapturedRequest } from "./_lib/request-file.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";
import { bootstrapThreadFromChannel } from "./_lib/thread-bootstrap.ts";

const RESERVED_TICKET_ID = "side-2";
const REQUEST = `Sur nimbus, sans ticket, améliore le bouton d'export.

- Ajoute une infobulle « Exporter les données ».
- Préserve son comportement clavier.
- Vérifie le rendu au survol.`;
const REQUEST_PATH = `${NIMBUS_PROJECT_PATH}/.plans/${RESERVED_TICKET_ID}/A1-request.md`;

export default async function explicitNoTicket(ctx: ScenarioContext): Promise<void> {
  await resetFixtures(ctx);
  await seedPriorNoTicketWork();
  const codingAgent = setupCodingAgentMock(ctx);
  setupGhMock(ctx);

  const starter = await bootstrapThreadFromChannel(ctx, {
    text: REQUEST,
    project: "nimbus",
    projectPath: NIMBUS_PROJECT_PATH,
    request: REQUEST,
  });
  await ctx.judgeLLM({
    attachTo: starter.entry,
    message: starter.match.text,
    rubric:
      "A thread starter preserving the explicit no-ticket nimbus request. It starts the working " +
      "session without asking for an external ticket ID or a mechanical follow-up (a reply so " +
      "the bot can start). An announcement that an internal or side ticket will be reserved, or " +
      "that the work continues in this thread, is the intended path and passes.",
    label: "explicit-no-ticket-starter",
  });

  await waitForCapturedRequest(REQUEST_PATH, REQUEST, 120_000);

  const { dir: worktreeDir } = await waitForAnyWorktreeDir(
    NIMBUS_PROJECT_PATH,
    RESERVED_TICKET_ID,
    { timeoutMs: 180_000 },
  );
  assertBranchForTicket(worktreeDir, RESERVED_TICKET_ID);
  const delegation = await expectCodingDelegation(ctx, codingAgent, {
    ticketId: RESERVED_TICKET_ID,
    rubric:
      "A captured coding-agent CLI invocation. Judge only the prompt text supplied through stdin; " +
      "CLI flags such as exec/--json/--sandbox are the runner's mechanics. Pass an AlignFirst " +
      "coding-protocol delegation for side ticket side-2 that asks to add a tooltip to the nimbus " +
      "export button. Reject only if the prompt asks the coding agent to choose a side-N " +
      "identifier, create the request file, or set up the workspace.",
    label: "explicit-no-ticket-coding-delegation",
    timeoutMs: 240_000,
  });
  if (delegation.cwd !== worktreeDir) {
    throw new Error(`coding ran from ${delegation.cwd}, expected linked worktree ${worktreeDir}`);
  }
  await waitForProjectListing(ctx, "channel session lists the projects");

  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}

async function seedPriorNoTicketWork(): Promise<void> {
  const taskDir = `${NIMBUS_PROJECT_PATH}/.plans/side-1`;
  await mkdir(taskDir, { recursive: true });
  await writeFile(`${taskDir}/A1-request.md`, "# Earlier no-ticket request\n", "utf8");
}
