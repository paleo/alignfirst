import type { AgentToolCall, ScenarioContext } from "@alignfirst/openclaw-test";
import {
  extractCodingPrompt,
  isCodingProtocolPrompt,
  setupCodingAgentMock,
} from "./_lib/mock-coding-agent.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import { lowestFreeFixtureBlock } from "./_lib/free-port-block.ts";
import { FIXTURE_PORT_BOUNDS } from "../scripts/fixture-personalization.ts";
import {
  assertGatewayCommand,
  pathExists,
  readProjectConfig,
  waitForLifecycle,
} from "./_lib/project-lifecycle.ts";
import { waitForReport } from "./_lib/outbound.ts";
import type { Step } from "./_lib/types.ts";
import { LIFECYCLE_PROJECT_PARENT, NOVA_PROJECT_PATH } from "./_lib/project-fixtures.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";
import { bootstrapThreadFromChannel, sendInThread } from "./_lib/thread-bootstrap.ts";

const PROJECT = "nova";
const PORTS_PER_WORKSPACE = "2";
const MAX_WORKSPACES = "4";
const PORT_BLOCK_SIZE = Number(PORTS_PER_WORKSPACE) * Number(MAX_WORKSPACES);
const PORT_BLOCK = lowestFreeFixtureBlock(PORT_BLOCK_SIZE);
// Relative to the effective plans: creation selects companion plans, outside the runner's mounts.
const REQUEST_FILE = "side-1/A1-request.md";

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
  await configureGitIdentity(ctx);
  let scaffoldCreated = false;
  const codingAgent = setupCodingAgentMock(ctx, {
    onPrompt: async (scenario, cwd, prompt) => {
      if (cwd !== NOVA_PROJECT_PATH) return;
      if (isCodingProtocolPrompt(prompt)) {
        throw new Error(`project creation used an AlignFirst protocol: ${prompt.slice(0, 200)}`);
      }
      const capturedRequest = await readCreationRequest(scenario);
      if (!hasCompleteCreationRequest(capturedRequest)) {
        throw new Error("project bootstrap started before the side-1 request reservation");
      }
      if (!scaffoldCreated) {
        await copyBootstrapTemplate(scenario);
        scaffoldCreated = true;
      }
      // Preserve the template's exact package manager if a verifying bot requests it.
      if (/\bpackageManager\b/u.test(prompt)) await declarePackageManager(scenario);
      await verifyProjectInventory(scenario);
      const holdsCommit = /\b(?:do not|don't|never)\s+(?:\w+\s+){0,3}commit\b/iu.test(prompt);
      if (
        !holdsCommit &&
        /\b(cr[ée]e|create|make|fais)\b[^.!\n]{0,80}\bcommit|git\s+commit\b/iu.test(prompt)
      ) {
        // Honor the commit message the bot chose — it may verify it in git log.
        const message =
          prompt.match(/['"`](chore:[^'"`]{3,80})['"`]/u)?.[1] ?? "chore: bootstrap nova project";
        await commitNovaBootstrap(scenario, message);
        return `Initial commit created on main: ${message}.`;
      }
      return (
        "Bootstrap complete in the main worktree. Created: package.json, pnpm-lock.yaml, " +
        "app.mjs, home-page.mjs, comparables.mjs, export-handler.mjs, app.test.mjs, " +
        "README.md, ASSISTANTS.md, docs/, scripts/workspace/ (workspace tooling), local.env.example, " +
        ".local/, .gitignore and a merged alignfirst.json declaring the frontend and api ports. " +
        "This minimal scaffold is deliberate and " +
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
  const capturedRequest = await waitForCreationRequest(ctx, 120_000);
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
        portRange?.first === PORT_BLOCK.first &&
        portRange.last === PORT_BLOCK.last
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

async function configureGitIdentity(ctx: ScenarioContext): Promise<void> {
  await assertGatewayCommand(
    ctx,
    ["git", "config", "--global", "user.name", "myassistant"],
    "deployment Git author name",
  );
  await assertGatewayCommand(
    ctx,
    ["git", "config", "--global", "user.email", "myassistant@example.test"],
    "deployment Git author email",
  );
}

async function waitForCreationRequest(ctx: ScenarioContext, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const request = await readCreationRequest(ctx);
    if (request !== "") return request;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`the ${REQUEST_FILE} creation request did not appear within ${timeoutMs}ms`);
}

/** The request in nova's effective plans, or "" while the project or the file is absent. */
async function readCreationRequest(ctx: ScenarioContext): Promise<string> {
  const result = await ctx.execInGateway(
    [
      "node",
      "-e",
      "const fs=require('node:fs');const cp=require('node:child_process');" +
        "const [cwd,file]=process.argv.slice(1);try{" +
        "const config=JSON.parse(cp.execFileSync('alignfirst',['config','--json'],{cwd,encoding:'utf8',stdio:['ignore','pipe','ignore']}));" +
        "process.stdout.write(fs.readFileSync(config.locations['.plans'].path+'/'+file,'utf8'));}catch{}",
      NOVA_PROJECT_PATH,
      REQUEST_FILE,
    ],
    { timeoutMs: 30_000 },
  );
  if (result.exitCode !== 0) throw new Error(`creation request read failed: ${result.stderr}`);
  return result.stdout;
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
        m.direction === "outbound" && m.threadId === starter.threadId && m.id !== starter.match.id,
      { sinceCursor: cursor, timeoutMs: Math.max(1_000, deadline - Date.now()) },
    );
    cursor = wait.nextCursor;
    seen.push(wait.match.text);
    const { parsed } = await ctx.judgeLLMJson<{ done: boolean; reason: string }>({
      message: wait.match.text,
      prompt:
        `This thread is creating ${PROJECT}. Does this message report that the project has been CREATED and is ` +
        "ready after bootstrap and the initial commit? A commit reference or clear overall " +
        "completion statement can establish that outcome. The report need not repeat the project " +
        "name, configuration contents, or port allocation; these are checked separately. A launch or " +
        'in-progress announcement ("the agent is working in the background", "je te fais signe") is NOT done.',
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
      // A correction run that changed nothing still succeeds: nothing to commit.
      `cd "${NOVA_PROJECT_PATH}" && git add -A && (git diff --cached --quiet || ` +
        `git -c user.email=mock@local -c user.name=mock commit -q -m "${message}")`,
    ],
    { timeoutMs: 30_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `bootstrap commit failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
    );
  }
}

async function declarePackageManager(ctx: ScenarioContext): Promise<void> {
  const result = await ctx.execInGateway(
    [
      "node",
      "-e",
      'const fs=require("node:fs");const p=process.argv[1];const pkg=JSON.parse(fs.readFileSync(p,"utf8"));' +
        'pkg.packageManager??="pnpm@12.14.0";fs.writeFileSync(p,JSON.stringify(pkg,null,2)+"\\n");',
      `${NOVA_PROJECT_PATH}/package.json`,
    ],
    { timeoutMs: 30_000 },
  );
  if (result.exitCode !== 0) throw new Error(`packageManager declaration failed: ${result.stderr}`);
}

async function copyBootstrapTemplate(ctx: ScenarioContext): Promise<void> {
  const result = await ctx.execInGateway(
    [
      "sh",
      "-c",
      `cp -R /opt/aligndev-openclaw-tests/fixtures/template/. "${NOVA_PROJECT_PATH}/" && ` +
        `mkdir -p "${NOVA_PROJECT_PATH}/.local" && ` +
        `node --input-type=module -e 'import fs from "node:fs"; ` +
        `import { patchDevServerRange } from "/opt/openclaw-test/scripts/fixture-personalization.ts"; ` +
        `const p = "${NOVA_PROJECT_PATH}/alignfirst.json"; ` +
        `const m = JSON.parse(patchDevServerRange(fs.readFileSync(p, "utf8"), ` +
        `${PORT_BLOCK.first}, ${PORT_BLOCK.last})); ` +
        // The request asks for two ports per workspace.
        `m.devServer.ports.declare = ["frontend", "api"]; ` +
        `fs.writeFileSync(p, JSON.stringify(m, null, 2) + "\\n");'`,
    ],
    { timeoutMs: 30_000 },
  );
  if (result.exitCode !== 0) throw new Error(`creation bootstrap failed: ${result.stderr}`);
}

async function verifyProjectInventory(ctx: ScenarioContext): Promise<void> {
  await assertGatewayCommand(
    ctx,
    ["aligndev", "project", "doctor"],
    "project inventory doctor before workspace setup",
  );
}

function assertCreationCalls(calls: AgentToolCall[]): void {
  const commands = calls
    .filter((call) => call.toolName === "exec")
    .map((call) => JSON.stringify(call.input));
  const freePortsCommand = commands.find((command) =>
    /aligndev\s+project\s+free-ports\b/.test(command),
  );
  if (freePortsCommand === undefined) {
    throw new Error(`missing free-ports call: ${JSON.stringify(commands)}`);
  }
  if (!new RegExp(`--size(?:\\s+|=)${PORT_BLOCK_SIZE}\\b`).test(freePortsCommand)) {
    throw new Error(
      `free-ports call did not request size ${PORT_BLOCK_SIZE}: ${JSON.stringify(commands)}`,
    );
  }
  // The bounds come from workspace/AGENTS.md; the default root applies.
  const within = `${FIXTURE_PORT_BOUNDS.first}\\.\\.${FIXTURE_PORT_BOUNDS.last}`;
  if (!new RegExp(`--within(?:\\s+|=)${within}(?!\\d)`).test(freePortsCommand)) {
    throw new Error(
      `free-ports call did not pass --within ${FIXTURE_PORT_BOUNDS.first}..${FIXTURE_PORT_BOUNDS.last}: ${freePortsCommand}`,
    );
  }
  if (/--root\b/.test(freePortsCommand)) {
    throw new Error(`free-ports call passed --root: ${freePortsCommand}`);
  }
  const allocatedExpectedBlock = calls.some((call) => {
    if (
      call.toolName !== "exec" ||
      !/aligndev\s+project\s+free-ports\b/.test(JSON.stringify(call.input))
    ) {
      return false;
    }
    // Digit lookarounds, not `\b`: the serialized result escapes a newline as `\n`, so a
    // chained command's output reads `n<port>`, where `\b` finds no boundary.
    const result = JSON.stringify(call.result);
    return (
      result !== undefined &&
      new RegExp(`(?<!\\d)${PORT_BLOCK.first}(?!\\d)`).test(result) &&
      new RegExp(`(?<!\\d)${PORT_BLOCK.last}(?!\\d)`).test(result)
    );
  });
  if (!allocatedExpectedBlock) {
    throw new Error(
      `free-ports did not return the lowest free block ${PORT_BLOCK.first}..${PORT_BLOCK.last} ` +
        `within ${FIXTURE_PORT_BOUNDS.first}..${FIXTURE_PORT_BOUNDS.last}`,
    );
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
  if (!prompts.some((prompt) => /setup guide assistant-project/u.test(prompt))) {
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
      "node",
      "-e",
      `const fs=require('node:fs'); const cp=require('node:child_process'); const r=JSON.parse(cp.execFileSync('alignfirst',['config','--json'],{cwd:${JSON.stringify(NOVA_PROJECT_PATH)},encoding:'utf8'})); if(r.workspace.schemaVersion!==1) process.exit(1);`,
    ],
    "validated workspace manifest with default .local sharing",
  );
  await assertPreparedProjectContract(ctx);
}

async function assertPreparedProjectContract(ctx: ScenarioContext): Promise<void> {
  await assertGatewayCommand(
    ctx,
    ["grep", "-F", "REMOTE_DEV_DOMAIN", `${NOVA_PROJECT_PATH}/scripts/workspace/run-file.mjs`],
    "public URLs from the environment",
  );
  await assertGatewayCommand(
    ctx,
    ["grep", "-F", "REMOTE_DEV_HOST", `${NOVA_PROJECT_PATH}/scripts/workspace/run-file.mjs`],
    "direct remote URLs from the environment",
  );
  await assertGatewayCommand(
    ctx,
    ["grep", "-F", "runFilesInputs", `${NOVA_PROJECT_PATH}/alignfirst.json`],
    "run-file environment input tracking",
  );
  await assertGatewayCommand(
    ctx,
    ["grep", "-F", "PUBLIC_URL", `${NOVA_PROJECT_PATH}/scripts/workspace/run-file.mjs`],
    "public dev-server URL",
  );
  await assertGatewayCommand(
    ctx,
    ["grep", "-F", "### Remote access", `${NOVA_PROJECT_PATH}/README.md`],
    "remote-access documentation",
  );
}
