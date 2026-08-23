import type { ScenarioContext } from "@paleo/openclaw-test";
import { setupAlprojectMock } from "./_lib/mock-alproject.ts";
import { setupCodingAgentMock } from "./_lib/mock-coding-agent.ts";
import { setupGhMock } from "./_lib/mock-gh.ts";
import {
  assertAgentCommandOrder,
  assertAlprojectCallOrder,
  assertGatewayCommand,
  pathExists,
  waitForLifecycle,
} from "./_lib/project-lifecycle.ts";
import { LIFECYCLE_PROJECT_PARENT, NOVA_PROJECT_PATH } from "./_lib/project-fixtures.ts";
import { resetFixtures } from "./_lib/reset-fixture.ts";
import { bootstrapThreadFromChannel, sendInThread } from "./_lib/thread-bootstrap.ts";

const PROJECT = "nova";
const PORTS_PER_WORKSPACE = "2";
const MAX_WORKSPACES = "4";

export default async function projectCreation(ctx: ScenarioContext): Promise<void> {
  await resetFixtures(ctx);
  const alproject = setupAlprojectMock(ctx, {
    guide: lifecycleGuide(),
    registerBasePort: 6600,
  });
  setupCodingAgentMock(ctx, {
    onCodingProtocol: async (scenario, cwd) => {
      if (cwd !== NOVA_PROJECT_PATH) return;
      await copyBootstrapTemplate(scenario);
      return "Bootstrap complete in the main worktree. The files are ready for the initial commit.";
    },
  });
  setupGhMock(ctx);

  const starter = await bootstrapThreadFromChannel(ctx, {
    text: `Crée le nouveau projet ${PROJECT}.`,
    project: PROJECT,
    audience: "tech",
  });
  if (pathExists(NOVA_PROJECT_PATH)) {
    throw new Error("channel session created the absent project before the thread started");
  }
  await sendInThread(
    ctx,
    starter.threadId,
    `Utilise Node.js avec pnpm. Crée ${PROJECT} sous ${LIFECYCLE_PROJECT_PARENT}. ` +
      `Réserve ${PORTS_PER_WORKSPACE} ports par workspace pour ${MAX_WORKSPACES} workspaces. ` +
      "Tu peux procéder jusqu'au commit initial sur main.",
  );

  await waitForLifecycle(
    () =>
      pathExists(`${NOVA_PROJECT_PATH}/.git`) &&
      alproject.projects.some((project) => project.mainPath === NOVA_PROJECT_PATH) &&
      alproject.calls.some(
        (call) => call.argv.length === 1 && call.argv[0] === "list" && call.order > 2,
      ),
    { label: "project creation and refreshed inventory" },
  );

  assertCreationCalls(alproject.calls);
  await assertCreatedRepository(ctx);
  const agentCalls = ctx.getAgentToolCalls();
  const linkedWorkspaceBeforeInitialCommit = agentCalls.some((call) => {
    const command = call.toolName === "exec" ? JSON.stringify(call.input) : "";
    return /workspace\s+setup[^;&|]*(?:\s-c\b|--create\b)/.test(command);
  });
  if (linkedWorkspaceBeforeInitialCommit) {
    throw new Error("creation used a linked workspace before the initial commit");
  }
  assertAgentCommandOrder(
    agentCalls,
    (command) => /git\s+(?:-[^;]+\s+)*init\b/.test(command),
    (command) => /git\s+(?:-[^;]+\s+)*commit\b/.test(command),
    "Git initialization must precede the initial commit",
  );

  ctx.markScenarioAsEnded("PASS");
  ctx.log("PASS");
}

function lifecycleGuide(): string {
  return `# alproject guide

Allowed parent for new lifecycle fixtures: ${LIFECYCLE_PROJECT_PARENT}

Create Node.js projects with pnpm. Register only after Git initialization. Keep bootstrap work and the initial commit on main. Request port allocation with both dimensions.
`;
}

async function copyBootstrapTemplate(ctx: ScenarioContext): Promise<void> {
  const result = await ctx.execInGateway(
    [
      "sh",
      "-c",
      `cp -R /opt/playbook-test/fixtures/template/. "${NOVA_PROJECT_PATH}/" && ` +
        `sed -i 's/base: 6500/base: 6600/' "${NOVA_PROJECT_PATH}/scripts/workspace/workspace.mjs"`,
    ],
    { timeoutMs: 30_000 },
  );
  if (result.exitCode !== 0) throw new Error(`creation bootstrap failed: ${result.stderr}`);
}

function assertCreationCalls(calls: ReturnType<typeof setupAlprojectMock>["calls"]): void {
  const register = calls.find((call) => call.argv[0] === "register");
  if (register === undefined) throw new Error(`missing register call: ${JSON.stringify(calls)}`);
  if (register.argv[1] !== NOVA_PROJECT_PATH) {
    throw new Error(`register used the wrong path: ${JSON.stringify(register.argv)}`);
  }
  assertOption(register.argv, "--ports-per-workspace", PORTS_PER_WORKSPACE);
  assertOption(register.argv, "--max-workspaces", MAX_WORKSPACES);
  assertAlprojectCallOrder(
    calls,
    (call) => call.argv.length === 1 && call.argv[0] === "--guide",
    (call) => call.argv[0] === "register",
    "alproject guide must precede registration",
  );
  assertAlprojectCallOrder(
    calls,
    (call) => call.argv[0] === "register",
    (call) => call.argv.length === 1 && call.argv[0] === "list" && call.order > register.order,
    "registration must precede the refreshed inventory",
  );
}

function assertOption(argv: string[], option: string, expected: string): void {
  const index = argv.indexOf(option);
  if (index === -1 || argv[index + 1] !== expected) {
    throw new Error(`expected ${option} ${expected}: ${JSON.stringify(argv)}`);
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
}
