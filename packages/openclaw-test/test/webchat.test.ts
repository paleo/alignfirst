import { describe, expect, it } from "vitest";
import { createContext } from "../src/context.js";
import type { ExecInGatewayResult } from "../src/exec-rpc.js";
import type { ActionEntry, ReportEntry } from "../src/report.js";
import { createWebchatDriver, type WebchatDriver } from "../src/webchat.js";

const CONVERSATION_KEY = "agent:main:dashboard:62f03d49-7ab3-47e7-9b97-f35bda1ed919";
const HOME_KEY = "agent:main:main";
const SEND_RUN_ID = "run-send-1";

// Shapes recorded on OpenClaw 2026.10.5 (plan F4 of side-20).
const CREATE_RESPONSE = {
  ok: true,
  key: CONVERSATION_KEY,
  sessionId: "103b7e88-3058-4100-91c1-7348fa1304bc",
  entry: { sessionRoot: "/home/assistant/.openclaw/worktrees/829ef253a6520174/probe-two" },
  runStarted: false,
  worktree: {
    id: "36cf",
    path: "/home/assistant/.openclaw/worktrees/829ef253a6520174/probe-two",
    branch: "openclaw/probe-two",
  },
};

interface GatewayCall {
  method: string;
  params: Record<string, unknown>;
}

interface FakeGateway {
  calls: GatewayCall[];
  histories: Map<string, unknown[]>;
  entries: ReportEntry[];
  currentEntry(): ActionEntry | undefined;
  sessionKeys: Set<string>;
  sendResponse: Record<string, unknown>;
  driver: WebchatDriver;
}

describe("webchat driver", () => {
  it("creates a conversation on a managed worktree and returns its key and checkout", async () => {
    const gateway = createFakeGateway();
    const created = await gateway.driver.createConversation({
      label: "probe-2",
      cwd: "/home/assistant/projects/nimbus",
      worktree: { name: "probe-two" },
    });
    expect(created).toEqual({
      sessionKey: CONVERSATION_KEY,
      worktree: {
        path: "/home/assistant/.openclaw/worktrees/829ef253a6520174/probe-two",
        branch: "openclaw/probe-two",
      },
    });
    expect(gateway.calls).toEqual([
      {
        method: "sessions.create",
        params: {
          label: "probe-2",
          cwd: "/home/assistant/projects/nimbus",
          worktree: true,
          worktreeName: "probe-two",
        },
      },
    ]);
    expect([...gateway.sessionKeys]).toEqual([CONVERSATION_KEY]);
  });

  it("sends through chat.send and records an inboundSent entry carrying the run id", async () => {
    const gateway = createFakeGateway();
    const entry = await gateway.driver.send(CONVERSATION_KEY, "Fix ABC-0261 in nimbus.");
    const send = gateway.calls.find((call) => call.method === "chat.send");
    expect(send?.params).toMatchObject({
      sessionKey: CONVERSATION_KEY,
      message: "Fix ABC-0261 in nimbus.",
      idempotencyKey: expect.any(String),
    });
    expect(entry).toMatchObject({
      kind: "inboundSent",
      messageId: SEND_RUN_ID,
      text: "Fix ABC-0261 in nimbus.",
      senderId: "operator",
    });
    expect(gateway.entries).toEqual([entry]);
  });

  it("falls back to the idempotency key when chat.send returns no run id", async () => {
    const gateway = createFakeGateway();
    delete gateway.sendResponse.runId;
    const entry = await gateway.driver.send(CONVERSATION_KEY, "go");
    const send = gateway.calls.find((call) => call.method === "chat.send");
    expect(entry.messageId).toBe(send?.params.idempotencyKey);
  });

  it("returns the first matching new reply and ignores replies already consumed", async () => {
    const gateway = createFakeGateway();
    const history = gateway.histories.get(CONVERSATION_KEY) as unknown[];
    history.push(userMessage(1, "earlier"), assistantReply(2, "earlier reply"));
    await gateway.driver.send(CONVERSATION_KEY, "go");
    history.push(
      userMessage(3, "go"),
      assistantToolUse(4),
      assistantReply(5, "Workspace ready."),
      assistantReply(6, "Delegation finished."),
    );

    const reply = await gateway.driver.waitForReply(CONVERSATION_KEY, (r) =>
      r.text.includes("finished"),
    );
    expect(reply).toMatchObject({ text: "Delegation finished.", timestamp: 1_792_864_006_000 });
    expect(reply.entry).toMatchObject({ kind: "outboundReceived", messageId: "msg-6" });
    expect(gateway.currentEntry()).toBe(reply.entry);
    expect(gateway.entries.map((e) => (e.kind === "outboundReceived" ? e.text : e.kind))).toEqual([
      "inboundSent",
      "Workspace ready.",
      "Delegation finished.",
    ]);

    await expect(
      gateway.driver.waitForReply(CONVERSATION_KEY, (r) => r.text.includes("ready"), {
        timeoutMs: 10,
      }),
    ).rejects.toThrow(`waitForReply: no reply in ${CONVERSATION_KEY} matched within 10ms`);
  });

  it("joins the text blocks of a reply and skips its thinking and image blocks", async () => {
    const gateway = createFakeGateway();
    await gateway.driver.send(CONVERSATION_KEY, "screenshot");
    (gateway.histories.get(CONVERSATION_KEY) as unknown[]).push({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "" },
        { type: "text", text: "Probe image attached." },
        { type: "image", artifactId: "artifact_managed_image_1", mimeType: "image/png" },
        { type: "text", text: "Second line." },
      ],
      stopReason: "stop",
      timestamp: 1_792_864_539_443,
      __openclaw: { runId: "run-1", id: "msg-8", seq: 8 },
    });
    const reply = await gateway.driver.waitForReply(CONVERSATION_KEY, () => true);
    expect(reply.text).toBe("Probe image attached.\nSecond line.");
  });

  it("fails expectNoReply on a new reply and passes on silence", async () => {
    const gateway = createFakeGateway();
    await gateway.driver.send(CONVERSATION_KEY, "hello");
    await expect(
      gateway.driver.expectNoReply(CONVERSATION_KEY, { withinMs: 10 }),
    ).resolves.toBeUndefined();
    (gateway.histories.get(CONVERSATION_KEY) as unknown[]).push(assistantReply(3, "Hi."));
    await expect(gateway.driver.expectNoReply(CONVERSATION_KEY, { withinMs: 10 })).rejects.toThrow(
      `expectNoReply: a reply arrived in ${CONVERSATION_KEY}: "Hi."`,
    );
  });

  it("resets Home once, before its first send", async () => {
    const gateway = createFakeGateway();
    expect(gateway.driver.homeKey).toBe(HOME_KEY);
    await gateway.driver.send(HOME_KEY, "first");
    await gateway.driver.send(HOME_KEY, "second");
    expect(gateway.calls.map((call) => call.method)).toEqual([
      "sessions.reset",
      "chat.history",
      "chat.send",
      "chat.history",
      "chat.send",
    ]);
    expect(gateway.calls[0]?.params).toEqual({ key: HOME_KEY });
    expect(gateway.sessionKeys.has(HOME_KEY)).toBe(true);
  });

  it("names the method and stderr when a gateway call fails", async () => {
    const gateway = createFakeGateway();
    await expect(gateway.driver.createConversation({ cwd: "/nowhere" })).rejects.toThrow(
      "gateway call sessions.create failed (exit 1): INVALID_REQUEST cwd does not exist",
    );
  });

  it("raises the RPC timeout and reports a transport error printed on stdout", async () => {
    const argvs: string[][] = [];
    const driver = createWebchatDriver({
      execInGateway: async (argv) => {
        argvs.push(argv);
        const stdout = JSON.stringify({
          ok: false,
          error: { type: "gateway_transport_error", kind: "timeout" },
        });
        return { exitCode: 1, stdout, stderr: "" };
      },
      emit: (entry) => entry,
      nextEntrySeqTs: () => ({ entrySeq: 0, ts: new Date().toISOString() }),
      setCurrentEntry: (entry) => entry,
      sessionKeys: new Set<string>(),
    });
    await expect(driver.send(HOME_KEY, "hi")).rejects.toThrow(
      'gateway call sessions.reset failed (exit 1): {"ok":false,"error":{"type":"gateway_transport_error"',
    );
    // Above the CLI's 10 s default, too short for a freshly started gateway.
    expect(argvs[0]?.at(-2)).toBe("--timeout");
    expect(Number(argvs[0]?.at(-1))).toBeGreaterThan(10_000);
  });
});

describe("context surfaces", () => {
  it("throws on the bus members of a webchat cell", () => {
    const { ctx } = createContext({ channel: "webchat", conversationId: "A26-webchat-abc" });
    expect(() => ctx.sendInbound({ senderId: "u", text: "hi" })).toThrow(
      "sendInbound is not available on the webchat surface",
    );
    expect(() => ctx.waitForOutbound(() => true, { sinceCursor: 0 })).toThrow(
      "waitForOutbound is not available on the webchat surface",
    );
  });

  it("throws on ctx.webchat calls in a channel cell", () => {
    const { ctx } = createContext({ channel: "discord-mock", conversationId: "A01-discord-abc" });
    expect(() => ctx.webchat.send(HOME_KEY, "hi")).toThrow(
      "ctx.webchat is available on the webchat surface only",
    );
  });
});

function createFakeGateway(): FakeGateway {
  const calls: GatewayCall[] = [];
  const histories = new Map<string, unknown[]>([
    [CONVERSATION_KEY, []],
    [HOME_KEY, []],
  ]);
  const entries: ReportEntry[] = [];
  const sessionKeys = new Set<string>();
  let current: ActionEntry | undefined;
  let entrySeq = 0;
  const sendResponse: Record<string, unknown> = {
    runId: SEND_RUN_ID,
    status: "started",
    messageSeq: 1,
  };
  const handlers: Record<string, (params: Record<string, unknown>) => unknown> = {
    "sessions.create": (params) => {
      if (params.cwd === "/nowhere") throw new Error("INVALID_REQUEST cwd does not exist");
      return CREATE_RESPONSE;
    },
    "sessions.reset": () => ({ ok: true, key: HOME_KEY }),
    "chat.send": () => sendResponse,
    "chat.history": (params) => ({
      sessionKey: params.sessionKey,
      messages: histories.get(params.sessionKey as string),
      hasMore: false,
    }),
  };
  const execInGateway = async (argv: string[]): Promise<ExecInGatewayResult> => {
    const method = argv[3] as string;
    const params = JSON.parse(argv[5] as string) as Record<string, unknown>;
    calls.push({ method, params });
    try {
      return { exitCode: 0, stdout: JSON.stringify(handlers[method]?.(params)), stderr: "" };
    } catch (err) {
      return { exitCode: 1, stdout: "", stderr: (err as Error).message };
    }
  };
  const driver = createWebchatDriver({
    execInGateway,
    emit: (entry) => {
      entries.push(entry);
      return entry;
    },
    nextEntrySeqTs: () => ({ entrySeq: entrySeq++, ts: new Date().toISOString() }),
    setCurrentEntry: (entry) => {
      current = entry;
      return entry;
    },
    sessionKeys,
  });
  return {
    calls,
    histories,
    entries,
    currentEntry: () => current,
    sessionKeys,
    sendResponse,
    driver,
  };
}

function userMessage(seq: number, text: string): unknown {
  return {
    role: "user",
    content: text,
    timestamp: 1_792_864_000_000 + seq * 1000,
    provenance: { kind: "external_user" },
    __openclaw: { id: `msg-${seq}`, seq },
  };
}

function assistantToolUse(seq: number): unknown {
  return {
    role: "assistant",
    content: [
      { type: "text", text: "Checking the workspace." },
      { type: "toolCall", id: `call-${seq}`, name: "exec", arguments: {} },
    ],
    stopReason: "toolUse",
    timestamp: 1_792_864_000_000 + seq * 1000,
    __openclaw: { runId: "run-1", id: `msg-${seq}`, seq },
  };
}

function assistantReply(seq: number, text: string): unknown {
  return {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "" },
      { type: "text", text },
    ],
    stopReason: "stop",
    timestamp: 1_792_864_000_000 + seq * 1000,
    __openclaw: { runId: "run-1", id: `msg-${seq}`, seq },
  };
}
