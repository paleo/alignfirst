import { readdirSync } from "node:fs";
import type { ScenarioContext, OutboundReceivedEntry } from "@paleo/openclaw-test";
import { inputOf } from "./agent-tool-calls.ts";
import { readGit } from "./fixture-state.ts";
import { waitForCodingSessionSucceeded, waitForFindingsReport } from "./coding-session.ts";
import { expectNoProtocolDelegation, setupCodingAgentMock } from "./mock-coding-agent.ts";
import { setupGhMock } from "./mock-gh.ts";
import { NIMBUS_PROJECT_PATH } from "./project-fixtures.ts";
import { waitForProjectListing } from "./project-lifecycle.ts";
import { assertWorktreePaths, bootstrapThreadFromChannel } from "./thread-bootstrap.ts";
import { waitForThreadSettlement } from "./thread-settlement.ts";

const INVESTIGATION_FINDING =
  "Investigation finding: handleExport in export-handler.mjs early-returns with a 204 when the region has no comparables, so the response carries no payload at all. The browser treats the empty body as a failed download and the button surfaces it as an error. Fix would be to either render a header-only CSV or surface a 'no comparables' message to the user. No source files were changed.";

export interface ReadOnlyQuestionOptions {
  text: string;
  worktreeDir: string;
  expectedBranch: string;
  expectedHead: string;
  existingWorktrees: string[];
  ticketId?: string;
}

export async function runReadOnlyQuestion(
  ctx: ScenarioContext,
  options: ReadOnlyQuestionOptions,
): Promise<void> {
  const initialPlanEntries = readdirSync(`${NIMBUS_PROJECT_PATH}/.plans`).sort();
  const investigations: { cwd: string; head: string; branch: string }[] = [];
  const codingAgent = setupCodingAgentMock(ctx, {
    streamDelayMs: 12_000,
    onPrompt: async (_scenario, cwd) => {
      investigations.push({
        cwd,
        head: readGit(cwd, ["rev-parse", "HEAD"]),
        branch: readGit(cwd, ["branch", "--show-current"]),
      });
      return INVESTIGATION_FINDING;
    },
  });
  const gh = setupGhMock(ctx);
  const starter = await bootstrapThreadFromChannel(ctx, {
    text: options.text,
    project: "nimbus",
    projectPath: NIMBUS_PROJECT_PATH,
    ticketId: options.ticketId,
  });
  const { cursorAfterDelegation } = await expectNoProtocolDelegation(ctx, codingAgent, {
    rubric:
      "The prompt delegates an investigation of why the export button fails when there are no " +
      "comparables. It explicitly requires read-only investigation without source changes. " +
      "It does not invoke an AlignFirst protocol or request implementation, workspace creation, " +
      "or ticket creation. A necessary dependency or build refresh is allowed. " +
      "Judge the stdin prompt only. Ignore the CLI sandbox and permission flags: those are " +
      "alcode defaults, not instructions to change files. The working directory and actual " +
      "absence of changes are asserted separately.",
    label: "read-only-question-delegation",
    timeoutMs: 300_000,
  });
  ctx.assertLength(investigations, 1, "one investigation delegation");
  ctx.assertEqual(investigations[0]?.cwd, options.worktreeDir, "investigation workspace");
  ctx.assertEqual(investigations[0]?.branch, options.expectedBranch, "investigation branch");
  ctx.assertEqual(
    investigations[0]?.head,
    options.expectedHead,
    "correct revision before investigation",
  );

  await waitForCodingSessionSucceeded(ctx, {
    ticketId: options.ticketId,
    allowNoTicketDir: true,
    timeoutMs: 120_000,
  });
  const report = await waitForFindingsReport(ctx, {
    conversationId: ctx.conversationId,
    threadId: starter.threadId,
    sinceCursor: cursorAfterDelegation,
    timeoutMs: 240_000,
    label: "investigation-summary",
  });
  const { entry } = await ctx.waitForOutbound((message) => message.id === report.message.id, {
    sinceCursor: cursorAfterDelegation,
    failFastUnmatchedOutbounds: false,
  });
  await assertFindings(ctx, entry, report.message.text);
  const claim = await ctx.waitForAgentToolCall(
    (call) =>
      call.toolName === "thread_handoff" &&
      inputOf(call).action === "claim" &&
      call.sessionKey?.toLowerCase().includes(starter.threadId.toLowerCase()) === true,
    { label: "question thread claims its handoff", timeoutMs: 30_000 },
  );
  if (claim.sessionKey === undefined) throw new Error("Missing question session key");
  await waitForThreadSettlement(ctx, claim.sessionKey);
  await waitForProjectListing(ctx, "channel session lists the projects");
  assertNoChanges(ctx, options, initialPlanEntries);
  ctx.assertLength(
    gh.calls.filter((call) => call.argv[0] === "issue" && call.argv[1] === "create"),
    0,
    "no GitHub ticket created",
  );
  ctx.assertLength(investigations, 1, "no extra coding delegation after findings");
  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}

async function assertFindings(
  ctx: ScenarioContext,
  entry: OutboundReceivedEntry,
  text: string,
): Promise<void> {
  await ctx.judgeLLM({
    attachTo: entry,
    message: text,
    rubric:
      "The answer explains that no comparables causes an empty HTTP 204 response, which the " +
      "browser treats as a failed download. It is concise and avoids repetition, unnecessary " +
      "setup narration, and a process recap, while retaining the causal explanation. " +
      "A proposed fix is optional; it must not claim a fix was implemented. " +
      "Allow any format and enough detail to explain the finding. Do not impose a word limit.",
    label: "concise-substantive-investigation-findings",
  });
}

function assertNoChanges(
  ctx: ScenarioContext,
  options: ReadOnlyQuestionOptions,
  initialPlanEntries: string[],
): void {
  assertWorktreePaths(ctx, options.existingWorktrees);
  ctx.assertEqual(
    readGit(options.worktreeDir, ["rev-parse", "HEAD"]),
    options.expectedHead,
    "no investigation commit",
  );
  ctx.assertEqual(readGit(options.worktreeDir, ["status", "--porcelain"]), "", "no source changes");
  const newPlanEntries = readdirSync(`${NIMBUS_PROJECT_PATH}/.plans`).filter(
    (entry) =>
      entry !== "_alcode" && entry !== options.ticketId && !initialPlanEntries.includes(entry),
  );
  ctx.assertLength(newPlanEntries, 0, "no new ticket or side-ticket directory");
}
