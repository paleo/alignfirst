import { execFileSync } from "node:child_process";
import type { AgentToolCall, ScenarioContext } from "@paleo/openclaw-test";
import { inputOf, listsProjects } from "./_lib/agent-tool-calls.ts";
import { waitForCodingSessionSucceeded, waitForFindingsReport } from "./_lib/coding-session.ts";
import { expectNoProtocolDelegation, setupCodingAgentMock } from "./_lib/mock-coding-agent.ts";
import { assertNoChannelRootLeak } from "./_lib/outbound.ts";
import { NIMBUS_PROJECT_PATH } from "./_lib/project-fixtures.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";
import { assertNoWorktreeDirs } from "./_lib/thread-bootstrap.ts";

const SENDER_ID = "ROBIN01";
const THREAD_TITLE = "Perfs export — à creuser";
const QUESTION =
  "Sur nimbus, pourquoi le bouton d'export échoue quand il n'y a pas de comparables ?";
const INVESTIGATION_FINDING =
  "Investigation finding: handleExport in export-handler.mjs early-returns with a 204 when the " +
  "region has no comparables, so the response carries no payload at all. The browser treats the " +
  "empty body as a failed download and the button surfaces it as an error. No source files were " +
  "changed.";

/**
 * A human opens the thread and tags the bot inside it. There is no starter and no recorded
 * handoff, so the session must resolve the project from the inventory itself — while still
 * reading itself as a working thread: no second thread, no channel-root starter, no rename of
 * a thread it did not name.
 */
export default async function humanCreatedThread(ctx: ScenarioContext): Promise<void> {
  await resetFixtures(ctx);
  const investigations: { cwd: string; branch: string }[] = [];
  const codingAgent = setupCodingAgentMock(ctx, {
    streamDelayMs: 12_000,
    onPrompt: async (_scenario, cwd) => {
      investigations.push({ cwd, branch: readGit(cwd, ["branch", "--show-current"]) });
      return INVESTIGATION_FINDING;
    },
  });

  const startCursor = await ctx.getCursor();
  const threadId = await ctx.createThread({ title: THREAD_TITLE, createdBy: SENDER_ID });
  await ctx.sendInbound({
    senderId: SENDER_ID,
    senderName: SENDER_ID,
    text: QUESTION,
    threadId,
    threadTitle: THREAD_TITLE,
  });

  const { cursorAfterDelegation } = await expectNoProtocolDelegation(ctx, codingAgent, {
    rubric:
      "The prompt delegates an investigation of why the export button fails when there are no " +
      "comparables. It explicitly requires read-only investigation without source changes. " +
      "It does not invoke an AlignFirst protocol or request implementation, workspace creation, " +
      "or ticket creation. Judge the stdin prompt only. Ignore the CLI sandbox and permission " +
      "flags: those are alcode defaults, not instructions to change files.",
    label: "human-thread-question-delegation",
    timeoutMs: 300_000,
  });
  ctx.assertLength(investigations, 1, "one investigation delegation");
  ctx.assertEqual(investigations[0]?.cwd, NIMBUS_PROJECT_PATH, "investigation runs in the project");
  ctx.assertEqual(investigations[0]?.branch, "main", "investigation stays on the main branch");

  await waitForCodingSessionSucceeded(ctx, { allowNoTicketDir: true, timeoutMs: 120_000 });
  const report = await waitForFindingsReport(ctx, {
    conversationId: ctx.conversationId,
    threadId,
    sinceCursor: cursorAfterDelegation,
    timeoutMs: 240_000,
    label: "human-thread-investigation-summary",
  });
  ctx.log(`answer delivered in the human-created thread ${threadId}: ${report.message.id}`);

  const calls = await ctx.getAgentToolCalls();
  assertStayedInTheThread(ctx, calls, threadId);
  ctx.assertLength(
    calls.filter(listsProjects),
    1,
    "the session resolved the project from the inventory itself",
  );
  await assertNoChannelRootLeak(ctx, { sinceCursor: startCursor });
  assertNoWorktreeDirs(ctx);
  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}

/** No second thread, and the author's thread name left alone. */
function assertStayedInTheThread(
  ctx: ScenarioContext,
  calls: AgentToolCall[],
  threadId: string,
): void {
  ctx.assertLength(
    calls.filter((call) => call.toolName === "thread_handoff" && inputOf(call).action === "start"),
    0,
    "no handoff start: the thread already exists",
  );
  ctx.assertLength(
    calls.filter((call) => call.toolName === "message" && inputOf(call).action === "thread-create"),
    0,
    "no thread created from inside a thread",
  );
  // A rename carries a non-empty `threadName`. Agents pass an empty one on unrelated calls (a
  // history `read`, for instance), which renames nothing.
  ctx.assertLength(
    calls.filter((call) => call.toolName === "message" && renamesThread(inputOf(call))),
    0,
    "the human's thread keeps its name",
  );
  ctx.log(`stayed in thread ${threadId} — OK`);
}

function renamesThread(input: Record<string, unknown>): boolean {
  return typeof input.threadName === "string" && input.threadName.trim() !== "";
}

function readGit(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}
