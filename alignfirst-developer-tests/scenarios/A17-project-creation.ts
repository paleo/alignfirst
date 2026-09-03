import { readFile } from "node:fs/promises";
import type { AgentToolCall, ScenarioContext } from "@paleo/openclaw-test";
import {
  extractCodingPrompt,
  isCodingProtocolPrompt,
  setupCodingAgentMock,
} from "./_lib/mock-coding-agent.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import {
  assertAgentCommandOrder,
  assertGatewayCommand,
  pathExists,
  readProjectConfig,
  waitForLifecycle,
} from "./_lib/project-lifecycle.ts";
import { waitForReport } from "./_lib/outbound.ts";
import type { Step } from "./_lib/types.ts";
import { LIFECYCLE_PROJECT_PARENT, NOVA_PROJECT_PATH } from "./_lib/project-fixtures.ts";
import { waitForFile } from "./_lib/request-file.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";
import { bootstrapThreadFromChannel, sendInThread } from "./_lib/thread-bootstrap.ts";

const PROJECT = "nova";
const PORTS_PER_WORKSPACE = "2";
const MAX_WORKSPACES = "4";
const ALLOCATED_PORT_RANGE = "6600..6607";
const REQUEST_PATH = `${NOVA_PROJECT_PATH}/.plans/side-1/A1-request.md`;

// Reliability note (2026-08-23, claude-sonnet-5): across seven stabilization
// runs this scenario never exceeded 50% on Discord (Slack ended 2/2). Creation
// is open-ended — the bot designs its own scaffold and verifies it — so every
// failure so far was scenario-side fidelity (mock replies the bot rightly
// distrusted, over-specified asserts), not a playbook violation; each was
// fixed, and the final assert set is unvalidated on Discord. Before tightening
// the playbook over an A17 failure, measure with `--iterations` and read the
// artifacts: the defect is more likely here than in the bot.
export default async function projectCreation(ctx: ScenarioContext): Promise<void> {
  await resetFixtures(ctx);
  const codingAgent = setupCodingAgentMock(ctx, {
    onPrompt: async (scenario, cwd, prompt) => {
      if (cwd !== NOVA_PROJECT_PATH) return;
      if (isCodingProtocolPrompt(prompt)) {
        throw new Error(`project creation used an AlignFirst protocol: ${prompt.slice(0, 200)}`);
      }
      const capturedRequest = await readFile(REQUEST_PATH, "utf8").catch(() => "");
      if (!hasCompleteCreationRequest(capturedRequest)) {
        throw new Error("project bootstrap started before the side-1 request reservation");
      }
      await copyBootstrapTemplate(scenario);
      // A bot may delegate the initial commit itself ("create one initial
      // commit with message …", "run git commit -m …"); comply, like a real
      // alcode. The affirmative verb (or a literal `git commit`) guards
      // against matching "do NOT commit" in a scaffold prompt.
      if (/\b(cr[ée]e|create|make|fais)\b[^.!\n]{0,80}\bcommit|git\s+commit\b/iu.test(prompt)) {
        // Honor the commit message the bot chose — it may verify it in git log.
        const message =
          prompt.match(/['"`](chore:[^'"`]{3,80})['"`]/u)?.[1] ?? "chore: bootstrap nova project";
        await commitNovaBootstrap(scenario, message);
        return `Initial commit created on main: ${message}.`;
      }
      return (
        "Bootstrap complete in the main worktree. Created: package.json, pnpm-lock.yaml, " +
        "app.mjs, home-page.mjs, comparables.mjs, export-handler.mjs, app.test.mjs, " +
        "README.md, DEVELOPERS.md, docs/, scripts/workspace/ (workspace tooling), local.env.example, " +
        ".local/, .gitignore, and .alignfirst.json. This minimal scaffold is deliberate and " +
        "complete — nothing else is required before the initial commit on main."
      );
    },
  });
  setupGhMock(ctx);

  const starter = await bootstrapThreadFromChannel(ctx, {
    text: `Crée le nouveau projet ${PROJECT}.`,
    project: PROJECT,
  });
  if (pathExists(NOVA_PROJECT_PATH)) {
    throw new Error("channel session created the absent project before the thread started");
  }
  const goAheadCursor = await sendInThread(
    ctx,
    starter.threadId,
    `Utilise Node.js avec pnpm. Crée ${PROJECT} sous ${LIFECYCLE_PROJECT_PARENT}. ` +
      `Réserve ${PORTS_PER_WORKSPACE} ports par workspace pour ${MAX_WORKSPACES} workspaces. ` +
      "Tu peux procéder jusqu'au commit initial sur main.",
  );
  const capturedRequest = await waitForFile(REQUEST_PATH, 120_000);
  if (!hasCompleteCreationRequest(capturedRequest)) {
    throw new Error(`side-1 creation request omitted details: ${JSON.stringify(capturedRequest)}`);
  }

  // Completion is the initial commit (the loose ref appears when it lands on
  // main) plus the prepared project config.
  await waitForLifecycle(
    () => {
      const portRange = readProjectConfig(NOVA_PROJECT_PATH)?.portRange;
      return (
        pathExists(`${NOVA_PROJECT_PATH}/.git/refs/heads/main`) &&
        portRange?.first === 6600 &&
        portRange.last === 6607
      );
    },
    // Creation is the suite's longest flow: guide reads, port allocation, the
    // delegated bootstrap, inspection, and the initial commit.
    { label: "project creation and initial commit", timeoutMs: 300_000 },
  );

  assertSetupGuideDelegation(codingAgent.codingAgentCalls);
  await assertCreatedRepository(ctx);
  const agentCalls = await ctx.getAgentToolCalls();
  assertCreationCalls(agentCalls);
  const linkedWorkspaceBeforeInitialCommit = agentCalls.some((call) => {
    const command = call.toolName === "exec" ? JSON.stringify(call.input) : "";
    return /workspace\s+setup[^;&|]*(?:\s-c\b|--create\b)/.test(command);
  });
  if (linkedWorkspaceBeforeInitialCommit) {
    throw new Error("creation used a linked workspace before the initial commit");
  }

  // The user-visible outcome: the thread reports the created project. Each
  // candidate is judged as it arrives — the launch ack and interleaved notes
  // legitimately precede the completion report and simply judge false.
  await waitForCreationReport(ctx, starter, goAheadCursor);

  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}

function hasCompleteCreationRequest(request: string): boolean {
  return [
    /\b(?:create|cr[ée]er?)\b/iu,
    new RegExp(`\\b${PROJECT}\\b`, "u"),
    /\bNode\.js\b/iu,
    /\bpnpm\b/iu,
    /\b2\b/iu,
    /\b4\b/iu,
    /(?:initial commit|commit initial)/iu,
    /\bmain\b/iu,
  ].every((pattern) => pattern.test(request));
}

async function waitForCreationReport(
  ctx: ScenarioContext,
  starter: Step,
  sinceCursor: number,
): Promise<void> {
  // Creation ends the turn on the report; on Slack nothing posts before turn
  // end, and the whole flow runs in that one turn — give it real headroom.
  const deadline = Date.now() + 240_000;
  const seen: string[] = [];
  let cursor = sinceCursor;
  for (;;) {
    const wait = await waitForReport(
      ctx,
      (m) =>
        m.direction === "outbound" &&
        m.threadId === starter.threadId &&
        m.id !== starter.match.id &&
        /\bnova\b/iu.test(m.text) &&
        m.text.includes("6600") &&
        m.text.includes("6607"),
      { sinceCursor: cursor, timeoutMs: Math.max(1_000, deadline - Date.now()) },
    );
    cursor = wait.nextCursor;
    seen.push(wait.match.text);
    const { parsed } = await ctx.judgeLLMJson<{ done: boolean; reason: string }>({
      message: wait.match.text,
      prompt:
        `Does this thread message report that the ${PROJECT} project has been CREATED and is ` +
        "ready — the bootstrap or initial commit done, and its `.alignfirst.json` written — and report " +
        `the full allocated port range ${ALLOCATED_PORT_RANGE}? Any equivalent range notation ` +
        'counts. A launch or in-progress announcement ("the agent is working in the ' +
        'background", "je te fais signe") is NOT done.',
      returnType: '{ "done": boolean, "reason": string }',
      label: "creation-report",
    });
    if (parsed.done) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `no creation completion report among ${seen.length} candidate(s): ${JSON.stringify(seen)}`,
      );
    }
  }
}

async function commitNovaBootstrap(ctx: ScenarioContext, message: string): Promise<void> {
  const result = await ctx.execInGateway(
    [
      "sh",
      "-c",
      `cd "${NOVA_PROJECT_PATH}" && git add -A && ` +
        `git -c user.email=mock@local -c user.name=mock commit -q -m "${message}"`,
    ],
    { timeoutMs: 30_000 },
  );
  if (result.exitCode !== 0) throw new Error(`bootstrap commit failed: ${result.stderr}`);
}

async function copyBootstrapTemplate(ctx: ScenarioContext): Promise<void> {
  const config = JSON.stringify(
    { schemaVersion: 1, portRange: { first: 6600, last: 6607 } },
    null,
    2,
  );
  const result = await ctx.execInGateway(
    [
      "sh",
      "-c",
      `cp -R /opt/alignfirst-developer-tests/fixtures/template/. "${NOVA_PROJECT_PATH}/" && ` +
        `mkdir -p "${NOVA_PROJECT_PATH}/.local" && ` +
        `sed -i -e 's/base: 6500/base: 6600/' ` +
        // Match the project config the bot wrote (2 ports × 4 workspaces) —
        // a verifying bot treats a mismatched template as a bootstrap defect
        // and loops on fixing it.
        `-e 's/maxWorkspaces: 10/maxWorkspaces: ${MAX_WORKSPACES}/' ` +
        `"${NOVA_PROJECT_PATH}/scripts/workspace/workspace.mjs" && ` +
        `printf '%s\\n' '${config}' > "${NOVA_PROJECT_PATH}/.alignfirst.json"`,
    ],
    { timeoutMs: 30_000 },
  );
  if (result.exitCode !== 0) throw new Error(`creation bootstrap failed: ${result.stderr}`);
}

function assertCreationCalls(calls: AgentToolCall[]): void {
  assertAgentCommandOrder(
    calls,
    /alcode\s+projects\s+--guide\b/,
    /git\s+init\b/,
    "projects guide must precede git initialization",
  );
  const commands = calls
    .filter((call) => call.toolName === "exec")
    .map((call) => JSON.stringify(call.input));
  const freePortsCommand = commands.find((command) =>
    /alcode\s+projects\s+free-ports\b/.test(command),
  );
  if (freePortsCommand === undefined) {
    throw new Error(`missing free-ports call: ${JSON.stringify(commands)}`);
  }
  if (!/--size(?:\s+|=)8\b/.test(freePortsCommand)) {
    throw new Error(`free-ports call did not request size 8: ${JSON.stringify(commands)}`);
  }
}

function assertSetupGuideDelegation(
  calls: ReturnType<typeof setupCodingAgentMock>["codingAgentCalls"],
): void {
  const prompts = calls.map(extractCodingPrompt).filter((prompt) => prompt !== undefined);
  const protocolPrompt = prompts.find(isCodingProtocolPrompt);
  if (protocolPrompt !== undefined) {
    throw new Error(`creation delegated through a protocol: ${JSON.stringify(protocolPrompt)}`);
  }
  if (!prompts.some((prompt) => /alignfirst-setup-guide/iu.test(prompt))) {
    throw new Error(
      `creation did not delegate through the setup guide: ${JSON.stringify(prompts)}`,
    );
  }
}

async function assertCreatedRepository(ctx: ScenarioContext): Promise<void> {
  const branch = await assertGatewayCommand(
    ctx,
    ["git", "-C", NOVA_PROJECT_PATH, "branch", "--show-current"],
    "created repository branch",
  );
  if (branch !== "main") throw new Error(`created repository is on ${branch}, expected main`);
  const commits = await assertGatewayCommand(
    ctx,
    ["git", "-C", NOVA_PROJECT_PATH, "rev-list", "--count", "HEAD"],
    "created repository commit count",
  );
  if (Number(commits) < 1) throw new Error("created repository has no initial commit");
  await assertGatewayCommand(
    ctx,
    ["git", "-C", NOVA_PROJECT_PATH, "check-ignore", ".local/probe"],
    ".local gitignore",
  );
  await assertGatewayCommand(
    ctx,
    [
      "grep",
      "-F",
      'sharedDirs: [".local", ".plans"]',
      `${NOVA_PROJECT_PATH}/scripts/workspace/workspace.mjs`,
    ],
    ".local shared workspace configuration",
  );
  await assertPreparedProjectContract(ctx);
}

async function assertPreparedProjectContract(ctx: ScenarioContext): Promise<void> {
  await assertGatewayCommand(
    ctx,
    ["grep", "-F", "setupProfiles:", `${NOVA_PROJECT_PATH}/scripts/workspace/workspace.mjs`],
    "remote setup profile",
  );
  await assertGatewayCommand(
    ctx,
    ["grep", "-F", "PUBLIC_URL", `${NOVA_PROJECT_PATH}/scripts/workspace/dev-server.mjs`],
    "public dev-server URL",
  );
  await assertGatewayCommand(
    ctx,
    ["grep", "-F", "### Remote access", `${NOVA_PROJECT_PATH}/README.md`],
    "remote-access documentation",
  );
}
