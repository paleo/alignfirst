import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentToolCall, ScenarioContext, WebchatDriver } from "@alignfirst/openclaw-test";
import {
  assertNoChannelTools,
  expectAppDelegationChain,
} from "../scenarios/_lib/app-conversation.ts";

const SESSION_KEY = "agent:main:dashboard:0f3c1e8a-5d2b-4c7e-9a41-2b6f8d0c3e57";
const NOT_BEFORE = "2026-10-24T10:00:00.000Z";
const LAUNCH =
  "cd /home/assistant/projects/nimbus-ABC-0260-bold-export && " +
  'aligndev code new --ticket ABC-0260 --protocol aad "Passer le bouton d\'export en gras"';
const WAKE = `openclaw system event --text "aligndev code run finished" --mode now --session-key ${SESSION_KEY}`;

test("assertNoChannelTools accepts calls without channel tools", async () => {
  await assertNoChannelTools(offlineContext([call("exec", { command: "ls" }), call("read", {})]));
});

for (const toolName of ["message", "thread_handoff"]) {
  test(`assertNoChannelTools rejects a \`${toolName}\` call`, async () => {
    await assert.rejects(
      assertNoChannelTools(offlineContext([call("exec", { command: "ls" }), call(toolName, {})])),
      new RegExp(`no \`${toolName}\` call`),
    );
  });
}

test("expectAppDelegationChain accepts a launch chaining this conversation's wake", async () => {
  // The chain stops at its first reply wait, after the launch checks.
  const ctx = offlineContext([launch(`${LAUNCH} ; ${WAKE}`)], new Error("launch checks completed"));
  await assert.rejects(chain(ctx), /launch checks completed/);
});

const REJECTED_LAUNCHES = [
  { name: "without the chained event", command: LAUNCH },
  { name: "chained with &&", command: `${LAUNCH} && ${WAKE}` },
  { name: "without --mode now", command: `${LAUNCH} ; ${WAKE.replace(" --mode now", "")}` },
  {
    name: "waking another session",
    command: `${LAUNCH} ; ${WAKE.replace(SESSION_KEY, "agent:main:main")}`,
  },
];

for (const { name, command } of REJECTED_LAUNCHES) {
  test(`expectAppDelegationChain rejects a launch ${name}`, async () => {
    await assert.rejects(chain(offlineContext([launch(command)])), /chains `openclaw system event/);
  });
}

test("expectAppDelegationChain rejects a foreground launch", async () => {
  const ctx = offlineContext([launch(`${LAUNCH} ; ${WAKE}`, { background: false })]);
  await assert.rejects(chain(ctx), /runs in the background/);
});

function chain(ctx: ScenarioContext): Promise<void> {
  return expectAppDelegationChain(ctx, {
    sessionKey: SESSION_KEY,
    ticketId: "ABC-0260",
    notBefore: NOT_BEFORE,
    launchIndex: 1,
  });
}

function launch(command: string, overrides: Record<string, unknown> = {}): AgentToolCall {
  return call("exec", { command, background: true, timeoutSeconds: 0, ...overrides });
}

function call(toolName: string, input: Record<string, unknown>): AgentToolCall {
  return {
    toolName,
    toolUseId: `${toolName}-${Math.random()}`,
    sessionKey: SESSION_KEY,
    input,
    startedAt: "2026-10-24T10:00:05.000Z",
  };
}

/** Fails on any operation beyond the tool-call reads; `stopAtReply` ends the chain at its first reply wait. */
function offlineContext(calls: AgentToolCall[], stopAtReply?: Error): ScenarioContext {
  const supported: Partial<ScenarioContext> = {
    getAgentToolCalls: async () => calls,
    waitForAgentToolCall: async (predicate, { label }) => {
      const match = calls.find(predicate);
      if (match === undefined) throw new Error(`offline: no call for ${label}`);
      return match;
    },
    assertEqual: (actual, expected, label) => assert.equal(actual, expected, label),
    assertLength: (value, expected, label) => assert.equal(value.length, expected, label),
    log: () => {},
    ...(stopAtReply === undefined ? {} : { webchat: stoppingDriver(stopAtReply) }),
  };
  return new Proxy(supported, {
    get(target, key) {
      if (Object.hasOwn(target, key)) return Reflect.get(target, key);
      throw new Error(`unexpected offline operation: ${String(key)}`);
    },
  }) as ScenarioContext;
}

function stoppingDriver(stop: Error): WebchatDriver {
  const unexpected = (): never => {
    throw new Error("unexpected offline webchat operation");
  };
  return {
    homeKey: "agent:main:main",
    createConversation: unexpected,
    send: unexpected,
    waitForReply: async () => {
      throw stop;
    },
    expectNoReply: unexpected,
  };
}
