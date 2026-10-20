import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { test, type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import type { CliMockHandler, ScenarioContext } from "@alignfirst/openclaw-test";
import { createClaudeAdapter } from "../../packages/aligndev/dist/code/claude-agent.js";
import { createCodexAdapter } from "../../packages/aligndev/dist/code/codex-agent.js";
import { createPiAdapter } from "../../packages/aligndev/dist/code/pi-agent.js";
import type { AgentAdapter, RunConfig } from "../../packages/aligndev/dist/code/run-agent.js";
import { type CodingAgent, PI_CONTRACT_MODEL } from "../scripts/coding-agent-settings.ts";

import {
  buildPiStreamResponse,
  type CodingAgentCall,
  extractCodingPrompt,
  isAlignfirstWrapperCall,
  isCodingProtocolPrompt,
  isLogReviewPrompt,
  MOCK_CONTEXT_TOKENS,
  type PiResponseVariant,
  pushMockFixtureBranch,
  type PushFixtureContext,
  renderCodingAgentCall,
  setupCodingAgentMock,
} from "../scenarios/_lib/mock-coding-agent.ts";

const PROMPT =
  "Run `alignfirst guide aad` and follow the protocol. Ticket ID = 29.\n\nFix `code` and $(literal).";
const WORKTREE = "/home/assistant/projects/nimbus-ABC-0120-export-bold";
const PUBLISH_REQUEST =
  "Publish the existing local commit on branch ABC-0120/export-bold: push it to origin " +
  "with upstream tracking. Do not change code or create a PR. Report the remote branch URL or push result.";

for (const agent of ["claude", "codex", "pi"] as const) {
  test(`${agent} uses stdin for new and resumed wrapper calls`, () => {
    for (const resumed of [false, true]) {
      const argv =
        agent === "pi"
          ? ["--mode", "json", ...(resumed ? ["--session", "session-1"] : [])]
          : agent === "claude"
            ? [
                "-p",
                "--output-format",
                "stream-json",
                "--verbose",
                "--permission-mode",
                "auto",
                ...(resumed ? ["--resume", "session-1"] : []),
              ]
            : [
                "exec",
                "--json",
                "--sandbox",
                "workspace-write",
                ...(resumed ? ["resume", "session-1"] : []),
                "-",
              ];
      const call: CodingAgentCall = { agent, argv, cwd: "/fixture", stdin: PROMPT };
      assert.equal(isAlignfirstWrapperCall(call), true);
      assert.equal(extractCodingPrompt(call), PROMPT);
      assert.ok(renderCodingAgentCall(call).includes(PROMPT));
    }
  });
}

test("recognizes the active protocol after catchup and ignores historical instructions", () => {
  const history = `Ticket history\n\n${PROMPT}`;
  assert.equal(isCodingProtocolPrompt(PROMPT), true);
  assert.equal(isCodingProtocolPrompt(`${history}\n\n## Current instruction\n\n${PROMPT}`), true);
  assert.equal(
    isCodingProtocolPrompt(`${history}\n\n## Current instruction\n\nSummarize the history.`),
    false,
  );
  assert.equal(
    isCodingProtocolPrompt("Run `alignfirst guide catchup` and follow the protocol."),
    false,
  );
});

test("rejects argv prompts and model-catalog calls as wrapper executions", () => {
  const call: CodingAgentCall = {
    agent: "codex",
    cwd: "/fixture",
    stdin: "",
    argv: ["exec", "--json", "--sandbox", "workspace-write", PROMPT],
  };
  assert.equal(isAlignfirstWrapperCall(call), false);
  assert.equal(extractCodingPrompt(call), undefined);
  assert.equal(extractCodingPrompt({ ...call, argv: ["debug", "models", "--bundled"] }), undefined);
});

test("recognizes log-review prompts with prose and file paths", () => {
  assert.equal(
    isLogReviewPrompt(
      "Inspect the dev-server logs under .local-wt/logs after manual testing. Report errors.",
    ),
    true,
  );
  assert.equal(
    isLogReviewPrompt(
      "Read .local-wt/logs/dev-server.log now. Return a verdict about errors or warnings.",
    ),
    true,
  );
  assert.equal(isLogReviewPrompt("Inspect the export button implementation."), false);
});

for (const prompt of [
  PUBLISH_REQUEST,
  `${PROMPT}\n\nCommit and push the completed change.`,
  "Could you push the existing branch to origin?",
  "Commit all changes, then push to origin.",
  "Pousse la branche existante vers origin.",
]) {
  test("explicit publication pushes the existing fixture commit without changing it", async (t) => {
    const fixture = createPushFixture(t);
    const before = fixture.git(["rev-parse", "HEAD"]);
    const result = await pushMockFixtureBranch(fixture.context, WORKTREE, prompt);
    assert.match(result ?? "", /Published the existing commit on ABC-0120\/export-bold to origin/u);
    assert.equal(fixture.git(["rev-parse", "HEAD"]), before);
    assert.equal(fixture.git(["status", "--porcelain"]), "");
    assert.equal(fixture.git(["rev-parse", "@{upstream}"]), before);
    assert.equal(
      fixture.git(["--git-dir", fixture.origin, "rev-parse", "refs/heads/ABC-0120/export-bold"]),
      before,
    );
  });
}

test("push mock ignores prohibitions, references, and historical publication instructions", async () => {
  const context: PushFixtureContext = {
    execInGateway: async () => {
      throw new Error("non-publication prompt invoked Git");
    },
  };
  for (const prompt of [
    "Commit the change. Do not push it.",
    "Never run git push.",
    "Commit and push the change. Do not push until approved.",
    "Explain how to commit and push the change.",
    "The documentation mentions `git push origin HEAD`.",
    "Publish the npm package.",
    "The docs say: push the branch after approval.",
    "Verify the existing remote branch without pushing.",
    `${PUBLISH_REQUEST}\n\n## Current instruction\n\nSummarize the earlier work.`,
  ]) {
    assert.equal(await pushMockFixtureBranch(context, WORKTREE, prompt), undefined, prompt);
  }
});

test("push mock refuses paths outside the linked fixture and non-fixture origins", async (t) => {
  const fixture = createPushFixture(t);
  for (const path of [
    "/home/assistant/projects/nimbus",
    `${WORKTREE}/nested`,
    `${WORKTREE}/../nimbus`,
  ]) {
    await assert.rejects(
      pushMockFixtureBranch(fixture.context, path, PUBLISH_REQUEST),
      /outside a fixture worktree/u,
    );
  }
  fixture.git(["remote", "set-url", "origin", "https://example.invalid/unrelated.git"]);
  await assert.rejects(
    pushMockFixtureBranch(fixture.context, WORKTREE, PUBLISH_REQUEST),
    /non-fixture origin/u,
  );
  assert.equal(
    fixture.git(["--git-dir", fixture.origin, "for-each-ref", "refs/heads/ABC-0120"]),
    "",
  );
});

for (const [agent, adapter] of [
  ["claude", createClaudeAdapter()],
  ["codex", createCodexAdapter()],
  ["pi", createPiAdapter()],
] as const) {
  test(`${agent} registered helper streams satisfy the real new/resume adapter`, async (t) => {
    const fixture = createMockFixture(t, agent);
    assert.equal(fixture.handle.selectedAgent, agent);
    assert.deepEqual([...fixture.handlers.keys()], ["claude", "codex", "pi"]);
    let nativeId: string | undefined;
    for (const resumed of [false, true]) {
      const config = mockRunConfig(fixture.home, resumed ? nativeId : undefined);
      const argv = adapter.buildArgs(config);
      const pendingCall = fixture.handle.waitForCall({
        predicate: (call) => call.argv === argv,
        timeoutMs: 1_000,
      });
      const response = await fixture.invoke(agent, argv);
      assert.equal((await pendingCall).argv, argv);
      assert.equal(response.exitCode, 0, response.stderr ?? "Mock exited unsuccessfully");
      const assessment = assessStream(adapter, config, response.stdout);
      assert.equal(assessment.succeeded, true, assessment.error ?? "Stream did not succeed");
      assert.equal(assessment.result, "Fixture result");
      assert.equal(assessment.contextTokens, MOCK_CONTEXT_TOKENS);
      assert.equal(assessment.contextCompacted, false);
      if (resumed) assert.equal(assessment.sessionId, nativeId);
      nativeId = assessment.sessionId;
      assert.ok(nativeId);
      const call = await fixture.handle.waitForCall({
        predicate: (call) => call.argv === argv,
        timeoutMs: 100,
      });
      assert.equal(call.agent, agent);
      assert.equal(call.stdin, PROMPT);
    }
    if (agent === "pi") assert.deepEqual(readdirSync(fixture.home), []);
    if (agent === "codex") {
      const catalog = await fixture.invoke("codex", ["debug", "models", "--bundled"]);
      assert.equal(catalog.exitCode, 0);
      assert.match(catalog.stdout, /gpt-5\.6-terra/u);
    }
  });
}

for (const argv of [
  [],
  ["--mode", "text"],
  ["--mode", "json", "positional prompt"],
  ["--mode", "json", "--model"],
  ["--mode", "json", "--model", " "],
  ["--mode", "json", "--session"],
  ["--mode", "json", "--session", ""],
  ["--mode", "json", "--model", "--session"],
  ["--mode", "json", "--session", "native-id", "--model", PI_CONTRACT_MODEL],
  ["--mode", "json", "--session", "id", "--session", "id"],
  ["--mode", "json", "--model", PI_CONTRACT_MODEL, "--model", PI_CONTRACT_MODEL],
  ["--mode", "json", "--approve"],
  ["--mode", "json", "--no-session"],
  ["--mode", "json", "-"],
]) {
  test(`Pi helper rejects malformed or bypass argv ${JSON.stringify(argv)}`, async (t) => {
    const call: CodingAgentCall = { agent: "pi", argv, stdin: PROMPT, cwd: "/fixture" };
    assert.equal(isAlignfirstWrapperCall(call), false);
    assert.equal(extractCodingPrompt(call), undefined);
    const fixture = createMockFixture(t, "pi");
    const response = await fixture.invoke("pi", argv);
    assert.equal(response.exitCode, 1);
    assert.equal(response.stdout, "");
    assert.match(response.stderr, /malformed pi invocation/u);
  });
}

test("Pi validates optional native model and session, and requires stdin", () => {
  const call: CodingAgentCall = {
    agent: "pi",
    cwd: "/fixture",
    stdin: PROMPT,
    argv: ["--mode", "json", "--model", PI_CONTRACT_MODEL, "--session", "native-id"],
  };
  assert.equal(isAlignfirstWrapperCall(call), true);
  assert.equal(extractCodingPrompt(call), PROMPT);
  assert.equal(isAlignfirstWrapperCall({ ...call, stdin: "  " }), false);
});

// Parser-only permutations (duplicate headers, invalid message blocks, usage fields, retries and
// post-settlement work) remain in packages/aligndev/test/code/pi-agent.test.ts.
for (const [variant, error, authEvidence] of [
  ["wrongIdentity", /differs from native-id/u, false],
  ["missingIdentity", /missing initial session header/u, false],
  ["missingSettlement", /before agent_settled/u, false],
  ["aborted", /after an abort/u, false],
  ["assistantError", /Pi provider fixture failure/u, false],
  ["authenticationFailure", /No API key found/u, true],
  ["malformedJson", /invalid JSON record/u, false],
  ["malformedHeader", /session header/u, false],
  ["malformedSettlement", /aborted boolean/u, false],
] satisfies [PiResponseVariant, RegExp, boolean][]) {
  test(`queued Pi ${variant} fails the real adapter contract`, async (t) => {
    const fixture = createMockFixture(t, "pi");
    const adapter = createPiAdapter();
    const config = mockRunConfig(fixture.home, "native-id");
    fixture.handle.queuePiResponse(variant);
    const response = await fixture.invoke("pi", adapter.buildArgs(config));
    const assessment = assessStream(adapter, config, response.stdout);
    assert.equal(assessment.succeeded, false);
    assert.match(assessment.error ?? "", error);
    assert.equal(assessment.authEvidence, authEvidence);
    if (variant === "assistantError" || variant === "aborted" || authEvidence) {
      assert.equal(assessment.result, undefined);
      assert.equal(response.exitCode, variant === "aborted" ? 0 : 1);
      assert.doesNotMatch(response.stdout, /Fixture result/u);
    }
    const next = await fixture.invoke("pi", adapter.buildArgs(config));
    assert.equal(assessStream(adapter, config, next.stdout).succeeded, true);
    assert.deepEqual(readdirSync(fixture.home), []);
  });
}

test("Pi streams are bounded deterministic version-3 records with latest-response occupancy", () => {
  const response = buildPiStreamResponse("native-id", "/fixture", "Fixture result");
  assert.deepEqual(response, buildPiStreamResponse("native-id", "/fixture", "Fixture result"));
  const records = response.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(records[0], {
    type: "session",
    version: 3,
    id: "native-id",
    timestamp: "2026-10-17T00:00:00.000Z",
    cwd: "/fixture",
  });
  assert.deepEqual(records.at(-1), { type: "agent_settled", aborted: false });
  assert.equal(records.at(-2).message.stopReason, "stop");
  const adapter = createPiAdapter();
  const config = mockRunConfig("/unused", "native-id");
  const assessment = assessStream(adapter, config, response.stdout);
  assert.equal(assessment.contextTokens, MOCK_CONTEXT_TOKENS);
  assert.notEqual(assessment.contextTokens, records.at(-2).message.usage.totalTokens);
  assert.throws(() => buildPiStreamResponse("id", "/fixture", "x".repeat(16_385)), /bounds/u);
});

function createMockFixture(t: TestContext, agent: CodingAgent) {
  const home = mkdtempSync(join(tmpdir(), "harness-coding-helper-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const handlers = new Map<string, CliMockHandler>();
  const supported: Partial<ScenarioContext> = {
    mockCli: (name, handler) => {
      assert.equal(handlers.has(name), false);
      handlers.set(name, handler);
    },
    currentEntry: undefined,
  };
  // The proxy supplies only mock registration/entry lookup; any service, provider or CLI call fails.
  const context = new Proxy(supported, {
    get(target, key) {
      if (key === "mockCli" || key === "currentEntry") return Reflect.get(target, key);
      throw new Error(`helper attempted a service/provider/CLI operation: ${String(key)}`);
    },
  }) as ScenarioContext;
  const handle = setupCodingAgentMock(context, {
    streamDelayMs: 0,
    environment: { CODING_AGENT: agent },
    codexHome: home,
    onPrompt: async () => "Fixture result",
  });
  async function invoke(name: string, argv: string[]) {
    const handler = handlers.get(name);
    assert.ok(handler, `unexpected real CLI fallback: ${name}`);
    let stdout = "";
    let stderr = "";
    const out = new Writable({
      write(chunk, _encoding, done) {
        stdout += chunk;
        done();
      },
    });
    const err = new Writable({
      write(chunk, _encoding, done) {
        stderr += chunk;
        done();
      },
    });
    const exitCode = await handler({
      argv,
      cwd: home,
      stdin: Readable.from([PROMPT]),
      stdout: out,
      stderr: err,
    });
    out.end();
    err.end();
    await setImmediate();
    return { exitCode, stdout, stderr };
  }
  return { handle, home, handlers, invoke };
}

function mockRunConfig(home: string, resume?: string): RunConfig {
  return {
    prompt: PROMPT,
    cwd: home,
    sessionFilePath: join(home, "run.md"),
    executableModel: PI_CONTRACT_MODEL,
    skipPermissions: false,
    additionalDirectories: [],
    env: { HOME: home, CODEX_HOME: home, PI_CODING_AGENT_DIR: join(home, "pi") },
    resume,
  };
}

function assessStream(adapter: AgentAdapter, config: RunConfig, stdout: string) {
  const state = adapter.createState(config);
  for (const line of stdout.trimEnd().split("\n")) adapter.interpretLine(line, state);
  return adapter.assess(state);
}

function createPushFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "mock-coding-push-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "projects/nimbus");
  const worktree = join(root, "projects/nimbus-ABC-0120-export-bold");
  const origin = join(root, ".fixture-origins/nimbus.git");
  mkdirSync(project, { recursive: true });
  mkdirSync(join(root, ".fixture-origins"));
  const env = {
    HOME: root,
    PATH: process.env.PATH,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  const git = (args: string[], cwd = worktree): string => {
    const result = spawnSync("git", args, {
      cwd,
      env,
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(["init", "-q", "-b", "main"], project);
  writeFileSync(join(project, "tracked.txt"), "fixture content\n");
  git(["add", "tracked.txt"], project);
  git(["-c", "user.email=mock@local", "-c", "user.name=mock", "commit", "-qm", "fixture"], project);
  git(["init", "-q", "--bare", "-b", "main", origin], project);
  git(["remote", "add", "origin", origin], project);
  git(["worktree", "add", "-b", "ABC-0120/export-bold", worktree], project);
  const context: PushFixtureContext = {
    execInGateway: async ([command, ...args]) => {
      const result = spawnSync(
        command,
        args.map((arg) => arg.replace("/home/assistant", root)),
        {
          env,
          encoding: "utf8",
          timeout: 5_000,
          maxBuffer: 64 * 1024,
        },
      );
      return {
        exitCode: result.status ?? 1,
        stdout: result.stdout.replaceAll(root, "/home/assistant"),
        stderr: result.stderr,
      };
    },
  };
  return { context, git, origin };
}
