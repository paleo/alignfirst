import { mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { ScenarioContext } from "@paleo/openclaw-test";
import { assertBranchForTicket, waitForAnyWorktreeDir } from "./_lib/fixture-state.ts";
import { setupAlprojectMock } from "./_lib/mock-alproject.ts";
import { expectCodingDelegation, setupCodingAgentMock } from "./_lib/mock-coding-agent.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import { NIMBUS_PROJECT_PATH } from "./_lib/project-fixtures.ts";
import { waitForFile } from "./_lib/request-file.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";
import { bootstrapThreadFromChannel, sendInThread } from "./_lib/thread-bootstrap.ts";

const RESERVED_TICKET_ID = "side-2";
const REQUEST = `Sur nimbus, sans ticket, améliore le bouton d'export.

- Ajoute une infobulle « Exporter les données ».
- Préserve son comportement clavier.
- Vérifie le rendu au survol.`;
const REQUEST_PATH = `${NIMBUS_PROJECT_PATH}/.plans/${RESERVED_TICKET_ID}/A1-request.md`;

export default async function explicitNoTicket(ctx: ScenarioContext): Promise<void> {
  await resetFixtures(ctx);
  await seedPriorNoTicketWork();
  const alproject = setupAlprojectMock(ctx);
  const codingAgent = setupCodingAgentMock(ctx);
  setupGhMock(ctx);

  const starter = await bootstrapThreadFromChannel(ctx, {
    text: REQUEST,
    project: "nimbus",
    projectPath: NIMBUS_PROJECT_PATH,
    request: REQUEST,
    codingAgent,
  });
  await ctx.judgeLLM({
    attachTo: starter.entry,
    message: starter.match.text,
    rubric:
      "A thread starter preserving the explicit no-ticket nimbus request. It asks only for a " +
      "reply to launch the working session and does not ask for an external ticket ID.",
    label: "explicit-no-ticket-starter",
  });

  await sendInThread(ctx, starter.threadId, "Vas-y sans ticket.");
  const capturedRequest = await waitForFile(REQUEST_PATH, 120_000);
  if (!capturedRequest.includes(REQUEST)) {
    throw new Error(`side-2 request omitted details: ${JSON.stringify(capturedRequest)}`);
  }
  await assertNoTicketWorktreeExists();

  const { dir: worktreeDir } = await waitForAnyWorktreeDir(
    NIMBUS_PROJECT_PATH,
    RESERVED_TICKET_ID,
    { timeoutMs: 180_000 },
  );
  assertBranchForTicket(worktreeDir, RESERVED_TICKET_ID);
  const delegation = await expectCodingDelegation(ctx, codingAgent, {
    ticketId: RESERVED_TICKET_ID,
    rubric:
      "An AlignFirst coding-protocol delegation for side ticket side-2. It asks to add a " +
      "tooltip to the nimbus export button. Reject if it asks alcode to choose a side-N identifier, " +
      "create the request file, or set up the workspace.",
    label: "explicit-no-ticket-coding-delegation",
    timeoutMs: 240_000,
  });
  if (delegation.cwd !== worktreeDir) {
    throw new Error(`coding ran from ${delegation.cwd}, expected linked worktree ${worktreeDir}`);
  }
  alproject.assertListCallCount(1);

  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}

async function assertNoTicketWorktreeExists(): Promise<void> {
  const parent = dirname(NIMBUS_PROJECT_PATH);
  const prefix = `${basename(NIMBUS_PROJECT_PATH)}-${RESERVED_TICKET_ID}-`;
  const entries = await readdir(parent, { withFileTypes: true });
  if (entries.some((entry) => entry.isDirectory() && entry.name.startsWith(prefix))) {
    throw new Error("side-2 workspace existed before its request file was observed");
  }
}

async function seedPriorNoTicketWork(): Promise<void> {
  const taskDir = `${NIMBUS_PROJECT_PATH}/.plans/side-1`;
  await mkdir(taskDir, { recursive: true });
  await writeFile(`${taskDir}/A1-request.md`, "# Earlier no-ticket request\n", "utf8");
}
