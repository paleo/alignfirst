import type { ScenarioContext } from "@paleo/openclaw-test";
import { NIMBUS_PROJECT_PATH } from "./_lib/project-fixtures.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";
import {
  type CodingAgent,
  type CodingAgentCall,
  type CodingAgentMockHandle,
  isCodexCatalogCall,
  setupCodingAgentMock,
} from "./_lib/mock-coding-agent.ts";

const PROJECT_DIR = NIMBUS_PROJECT_PATH;
const TICKET_ID = "ABC-0130";
const NEW_MESSAGE = "Inspect the fixture and report the result.";
const RESUME_MESSAGE = "Continue and confirm the result.";

interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export default async function alcodeAgentContract(ctx: ScenarioContext): Promise<void> {
  await resetFixtures(ctx);
  const mock = setupCodingAgentMock(ctx, { streamDelayMs: 0 });
  const agent = await readGatewayAgent(ctx);
  assertEqual(agent, mock.selectedAgent, "runner and gateway coding-agent selectors");

  const first = await runAlcode(ctx, [
    "new",
    "--ticket",
    TICKET_ID,
    "--message",
    NEW_MESSAGE,
    "--model",
    agent === "codex" ? "terra" : "sonnet",
  ]);
  assertEqual(first.exitCode, 0, "new alcode exit code");
  const firstSession = await readSession(ctx, first.stdout);
  assertSucceededSession(firstSession, agent, agent === "codex" ? "terra" : "sonnet");
  const sessionId = requiredFrontmatter(firstSession, "sessionId");
  assertSelectedNewCall(mock, agent);

  const resumed = await runAlcode(ctx, [
    "resume",
    sessionId,
    "--message",
    RESUME_MESSAGE,
    "--model",
    agent === "codex" ? "terra" : "sonnet",
  ]);
  assertEqual(resumed.exitCode, 0, "resume alcode exit code");
  const resumedSession = await readSession(ctx, resumed.stdout);
  assertSucceededSession(resumedSession, agent, agent === "codex" ? "terra" : "sonnet");
  assertEqual(requiredFrontmatter(resumedSession, "sessionId"), sessionId, "resumed session id");
  assertEqual(requiredFrontmatter(resumedSession, "ticket"), TICKET_ID, "resumed ticket");
  assertSelectedResumeCall(mock, agent, sessionId);

  if (agent === "codex") await assertCodexFailures(ctx, mock);

  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}

async function readGatewayAgent(ctx: ScenarioContext): Promise<CodingAgent> {
  const result = await ctx.execInGateway(["sh", "-lc", 'printf %s "$ALIGNFIRST_CODE_AGENT"']);
  if (result.exitCode !== 0) throw new Error(`failed to read gateway selector: ${result.stderr}`);
  if (result.stdout === "claude" || result.stdout === "codex") return result.stdout;
  throw new Error(`gateway ALIGNFIRST_CODE_AGENT is invalid: ${JSON.stringify(result.stdout)}`);
}

async function runAlcode(ctx: ScenarioContext, args: string[]): Promise<ExecResult> {
  return ctx.execInGateway(["alcode", ...args], { cwd: PROJECT_DIR, timeoutMs: 60_000 });
}

interface SessionSnapshot {
  frontmatter: Record<string, string>;
  result: string;
}

async function readSession(ctx: ScenarioContext, stdout: string): Promise<SessionSnapshot> {
  const relativePath = stdout.match(/^Session file: (.+)$/m)?.[1];
  if (relativePath === undefined) {
    throw new Error(`alcode output has no session-file path: ${JSON.stringify(stdout)}`);
  }
  const path = `${PROJECT_DIR}/${relativePath}`;
  const read = await ctx.execInGateway(["sed", "-n", "1,160p", path]);
  if (read.exitCode !== 0) throw new Error(`failed to read ${path}: ${read.stderr}`);
  const marker = "\n---- Result ----\n";
  const markerIndex = read.stdout.lastIndexOf(marker);
  if (markerIndex === -1) throw new Error(`session ${path} has no result block`);
  return {
    frontmatter: parseFrontmatter(read.stdout),
    result: read.stdout.slice(markerIndex + marker.length).trim(),
  };
}

function parseFrontmatter(content: string): Record<string, string> {
  const block = content.match(/^---\n([\s\S]*?)\n---\n/)?.[1];
  if (block === undefined) throw new Error("session file has no frontmatter");
  return Object.fromEntries(
    block.split("\n").map((line) => {
      const index = line.indexOf(":");
      return [
        line.slice(0, index),
        line
          .slice(index + 1)
          .trim()
          .replace(/^"|"$/g, ""),
      ];
    }),
  );
}

function assertSucceededSession(session: SessionSnapshot, agent: CodingAgent, model: string): void {
  assertEqual(requiredFrontmatter(session, "ticket"), TICKET_ID, "session ticket");
  assertEqual(requiredFrontmatter(session, "agent"), agent, "session agent");
  assertEqual(requiredFrontmatter(session, "model"), model, "session user-facing model");
  assertEqual(requiredFrontmatter(session, "status"), "succeeded", "session status");
  assertEqual(requiredFrontmatter(session, "exitReason"), "completed", "session exit reason");
  assertEqual(
    session.result,
    "Done. Implemented the requested change and verified it. Changes committed on the ticket branch.",
    "session result",
  );
}

function requiredFrontmatter(session: SessionSnapshot, key: string): string {
  const value = session.frontmatter[key];
  if (value === undefined || value === "") throw new Error(`session frontmatter ${key} is missing`);
  return value;
}

function assertSelectedNewCall(mock: CodingAgentMockHandle, agent: CodingAgent): void {
  assertNoOtherAgentExecutions(mock, agent);
  const calls = executionCalls(mock, agent);
  assertEqual(calls.length, 1, "new coding-agent execution count");
  const expected =
    agent === "codex"
      ? ["exec", "--json", "--sandbox", "workspace-write", "--model", "gpt-5.6-terra", NEW_MESSAGE]
      : [
          NEW_MESSAGE,
          "-p",
          "--output-format",
          "stream-json",
          "--verbose",
          "--permission-mode",
          "auto",
          "--model",
          "sonnet",
        ];
  assertArrayEqual(calls[0]?.argv, expected, "new coding-agent argv");
  if (agent === "codex") assertCodexCatalogOrder(mock, calls[0]);
}

function assertSelectedResumeCall(
  mock: CodingAgentMockHandle,
  agent: CodingAgent,
  sessionId: string,
): void {
  assertNoOtherAgentExecutions(mock, agent);
  const calls = executionCalls(mock, agent);
  assertEqual(calls.length, 2, "new and resume coding-agent execution count");
  const expected =
    agent === "codex"
      ? [
          "exec",
          "--json",
          "--sandbox",
          "workspace-write",
          "--model",
          "gpt-5.6-terra",
          "resume",
          sessionId,
          RESUME_MESSAGE,
        ]
      : [
          RESUME_MESSAGE,
          "-p",
          "--output-format",
          "stream-json",
          "--verbose",
          "--permission-mode",
          "auto",
          "--resume",
          sessionId,
          "--model",
          "sonnet",
        ];
  assertArrayEqual(calls[1]?.argv, expected, "resume coding-agent argv");
}

function assertNoOtherAgentExecutions(mock: CodingAgentMockHandle, agent: CodingAgent): void {
  const unexpected = mock.codingAgentCalls.filter(
    (call) => call.agent !== agent && !isCodexCatalogCall(call),
  );
  assertEqual(unexpected.length, 0, "other coding-agent execution count");
}

function executionCalls(mock: CodingAgentMockHandle, agent: CodingAgent): CodingAgentCall[] {
  return mock.codingAgentCalls.filter((call) => call.agent === agent && !isCodexCatalogCall(call));
}

function assertCodexCatalogOrder(mock: CodingAgentMockHandle, firstExec: CodingAgentCall): void {
  const catalogIndex = mock.codingAgentCalls.findIndex(isCodexCatalogCall);
  const execIndex = mock.codingAgentCalls.indexOf(firstExec);
  if (catalogIndex === -1 || catalogIndex >= execIndex) {
    throw new Error("Codex bundled catalog was not queried before the first exec");
  }
}

async function assertCodexFailures(
  ctx: ScenarioContext,
  mock: CodingAgentMockHandle,
): Promise<void> {
  await assertCodexFailure(ctx, mock, "turnFailed", 1, "error", "Codex protocol failure");
  await assertCodexFailure(ctx, mock, "malformed", 1, "error", "without a final agent message");
  await assertCodexFailure(ctx, mock, "authenticationFailure", 2, "auth_required", "codex login");
  await assertCodexFailure(ctx, mock, "modelRejection", 1, "error", "not supported");
  await assertCodexFailure(ctx, mock, "nonzeroStderr", 1, "error", "exited unexpectedly");
}

async function assertCodexFailure(
  ctx: ScenarioContext,
  mock: CodingAgentMockHandle,
  variant: Parameters<CodingAgentMockHandle["queueCodexResponse"]>[0],
  exitCode: number,
  exitReason: string,
  resultFragment: string,
): Promise<void> {
  mock.queueCodexResponse(variant);
  const run = await runAlcode(ctx, [
    "new",
    "--ticket",
    TICKET_ID,
    "--message",
    `Exercise ${variant}.`,
    "--model",
    "terra",
  ]);
  assertEqual(run.exitCode, exitCode, `${variant} process exit code`);
  const session = await readSession(ctx, run.stdout);
  assertEqual(requiredFrontmatter(session, "status"), "failed", `${variant} session status`);
  assertEqual(requiredFrontmatter(session, "ticket"), TICKET_ID, `${variant} ticket`);
  assertEqual(requiredFrontmatter(session, "exitReason"), exitReason, `${variant} exit reason`);
  if (!session.result.toLowerCase().includes(resultFragment.toLowerCase())) {
    throw new Error(`${variant} result does not include ${JSON.stringify(resultFragment)}`);
  }
}

function assertArrayEqual(
  actual: readonly string[] | undefined,
  expected: readonly string[],
  label: string,
): void {
  assertEqual(JSON.stringify(actual), JSON.stringify(expected), label);
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}
