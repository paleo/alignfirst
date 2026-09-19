import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import {
  type CodingAgentCall,
  extractCodingPrompt,
  isAlignfirstWrapperCall,
  isCodingProtocolPrompt,
  isLogReviewPrompt,
  pushMockFixtureBranch,
  type PushFixtureContext,
  renderCodingAgentCall,
} from "../scenarios/_lib/mock-coding-agent.ts";

const PROMPT =
  "Run `alignfirst guide aad` and follow the protocol. Ticket ID = 29.\n\nFix `code` and $(literal).";
const WORKTREE = "/home/claw/projects/nimbus-ABC-0120-export-bold";
const PUBLISH_REQUEST =
  "Publish the existing local commit on branch ABC-0120/export-bold: push it to origin " +
  "with upstream tracking. Do not change code or create a PR. Report the remote branch URL or push result.";

for (const agent of ["claude", "codex"] as const) {
  test(`${agent} uses stdin for new and resumed wrapper calls`, () => {
    for (const resumed of [false, true]) {
      const argv =
        agent === "claude"
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
    "/home/claw/projects/nimbus",
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

function createPushFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "mock-coding-push-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "projects/nimbus");
  const worktree = join(root, "projects/nimbus-ABC-0120-export-bold");
  const origin = join(root, ".fixture-origins/nimbus.git");
  mkdirSync(project, { recursive: true });
  mkdirSync(join(root, ".fixture-origins"));
  const git = (args: string[], cwd = worktree): string => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
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
        args.map((arg) => arg.replace("/home/claw", root)),
        {
          encoding: "utf8",
        },
      );
      return {
        exitCode: result.status ?? 1,
        stdout: result.stdout.replaceAll(root, "/home/claw"),
        stderr: result.stderr,
      };
    },
  };
  return { context, git, origin };
}
