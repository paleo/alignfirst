import type { ScenarioContext } from "@paleo/openclaw-test";
import {
  execCommandOf,
  execMatches,
  invokesAlcode,
  invokesCodingAgentDirectly,
} from "./agent-tool-calls.ts";
import {
  waitForBackgroundStartedAck,
  waitForCodingSessionSucceeded,
  waitForFinalWorkflowCompletionReport,
} from "./coding-session.ts";
import { isOpenclawNotice } from "./outbound.ts";
import { waitForThreadSettlement } from "./thread-settlement.ts";

export interface DelegationChainOptions {
  threadId: string;
  ticketId: string;
  /** Bus cursor taken before this phase's agent activity; every wait of the phase scans from it. */
  sinceCursor: number;
  /** ISO timestamp taken before this phase's inbound; the phase's launch is issued after it. */
  notBefore: string;
  /** 1-based rank used in assertion labels. */
  launchIndex: number;
}

/**
 * One delegation's full chain: the alcode launch exec with the guide's chained wake reply run, the
 * started ack, the `status: succeeded` session file started by this phase, and the completion
 * report in the work thread.
 */
export async function expectDelegationChain(
  ctx: ScenarioContext,
  opts: DelegationChainOptions,
): Promise<void> {
  const { threadId, sinceCursor, notBefore, launchIndex } = opts;

  // `waitForAgentToolCall` matches against all aggregated calls, so a plain predicate would
  // re-match an earlier launch: select the first launch issued after this phase's inbound. The
  // coding-agent subprocess is a cliMock, not an OpenClaw agent tool call.
  const launch = await ctx.waitForAgentToolCall(
    (call) =>
      invokesAlcode(call) &&
      execMatches(call, /--protocol/) &&
      call.startedAt !== undefined &&
      call.startedAt >= notBefore,
    {
      label: `agent delegates to the alcode CLI (launch #${launchIndex})`,
      timeoutMs: 180_000,
    },
  );
  if (invokesCodingAgentDirectly(launch)) {
    throw new Error(
      `agent invoked a coding agent directly instead of alcode: ${JSON.stringify(launch.input)}`,
    );
  }
  const input = launch.input;
  if (typeof input !== "object" || input === null) throw new Error("Missing exec input");
  ctx.assertEqual("background" in input && input.background, true, "alcode runs in background");
  ctx.assertEqual("timeoutSeconds" in input && input.timeoutSeconds, 0, "alcode has no timeout");
  // Structural pin of the chained completion wake — the outcome-level asserts below would also
  // pass on a bootstrap-path native wake (phase 1 always does), so assert the mechanism itself.
  const command = execCommandOf(launch);
  if (command === undefined) throw new Error("alcode launch call carries no exec command");
  ctx.assertRegex(
    command,
    /openclaw thread-handoff wake/,
    `launch #${launchIndex}: chains an \`openclaw thread-handoff wake\` turn`,
  );
  ctx.assertRegex(command, /--session-key/, `launch #${launchIndex}: wake targets a --session-key`);
  const launchStartedAt = launch.startedAt;
  if (launchStartedAt === undefined) {
    throw new Error(`alcode launch #${launchIndex} has no start timestamp`);
  }

  // The started ack: a batch judge over the thread's outbounds (see `waitForBackgroundStartedAck`).
  // Tolerant of phrasing/language and of interleaved reasoning narration — the message that tells
  // the user the work is running qualifies whatever its exact shape.
  await waitForBackgroundStartedAck(ctx, {
    conversationId: ctx.conversationId,
    threadId,
    sinceCursor,
    timeoutMs: 150_000,
    label: `background-started-ack-${launchIndex}`,
  });

  const sessionFilePath = await waitForCodingSessionSucceeded(ctx, {
    ticketId: opts.ticketId,
    timeoutMs: 120_000,
    notBefore: launchStartedAt,
  });
  ctx.log(`coding-session file #${launchIndex} succeeded: ${sessionFilePath}`);

  // The completion report: a batch judge picks the FINISHED report out of the thread window,
  // distinguishing it from the earlier ack and any launch banner — so both phases scan from
  // `sinceCursor` (phase 2's is taken before its inbound, so a stray duplicate wake of an earlier
  // run sits before it and is not considered). The judge, not a cursor offset, does the disambiguation.
  const report = await waitForFinalWorkflowCompletionReport(ctx, {
    conversationId: ctx.conversationId,
    threadId,
    sinceCursor,
    timeoutMs: 420_000,
    label: `final-completion-report-${launchIndex}`,
  });
  if (launch.sessionKey === undefined) throw new Error("alcode launch lacks session attribution");
  await waitForThreadSettlement(ctx, launch.sessionKey, launch.toolUseId);
  await assertNoReportsAfterCompletion(ctx, sinceCursor, threadId, report.message.id);
}

async function assertNoReportsAfterCompletion(
  ctx: ScenarioContext,
  sinceCursor: number,
  threadId: string,
  reportId: string,
): Promise<void> {
  const { messages } = await ctx.poll({ sinceCursor, timeoutMs: 1_000 });
  const reportIndex = messages.findIndex((message) => message.id === reportId);
  if (reportIndex === -1) throw new Error("Final report missing from the completion window");
  const repeats = messages
    .slice(reportIndex + 1)
    .filter(
      (message) =>
        message.direction === "outbound" &&
        message.threadId === threadId &&
        !isOpenclawNotice(message.text),
    );
  ctx.assertLength(repeats, 0, "real background completion produced no extra thread report");
}
