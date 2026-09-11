import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHandoffs, renderReceipts, wakeThreadSession } from "../src/thread-handoff/cli.js";
import { handoff, receipt } from "./helpers.js";

const gatewayRuntime = vi.hoisted(() => ({ callGatewayFromCli: vi.fn() }));

vi.mock("openclaw/plugin-sdk/gateway-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/gateway-runtime")>(
    "openclaw/plugin-sdk/gateway-runtime",
  );
  return { ...actual, callGatewayFromCli: gatewayRuntime.callGatewayFromCli };
});

describe("thread-handoff wake CLI", () => {
  beforeEach(() => {
    gatewayRuntime.callGatewayFromCli.mockReset();
  });

  it("forwards the wake and uses the regular turn budget for the default timeout", async () => {
    gatewayRuntime.callGatewayFromCli.mockResolvedValue({ status: "completed" });
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const api = cliApi();

    await wakeThreadSession(
      api,
      {
        sessionKey: "agent:main:slack:channel:C1:thread:100.200",
        message: "Report the result.",
        url: "ws://gateway.test",
        port: "1234",
        token: "token",
        password: "password",
        timeout: "30000",
      },
      true,
    );

    expect(gatewayRuntime.callGatewayFromCli).toHaveBeenCalledWith(
      "alignfirst-developer.wake",
      {
        url: "ws://gateway.test",
        port: "1234",
        token: "token",
        password: "password",
        timeout: "120000",
      },
      {
        sessionKey: "agent:main:slack:channel:C1:thread:100.200",
        message: "Report the result.",
      },
      { mode: "cli", scopes: ["operator.write", "operator.read"] },
    );
    expect(write).toHaveBeenCalledWith("Thread wake completed.\n");
    write.mockRestore();
  });

  it("rejects a failed wake result", async () => {
    gatewayRuntime.callGatewayFromCli.mockResolvedValue({ status: "failed", error: "turn failed" });

    await expect(
      wakeThreadSession(
        cliApi(),
        { sessionKey: "agent:main:discord:channel:T1", message: "Report.", timeout: "7000" },
        false,
      ),
    ).rejects.toThrow("turn failed");
  });

  it("propagates a gateway refusal", async () => {
    gatewayRuntime.callGatewayFromCli.mockRejectedValue(new Error("gateway refused"));

    await expect(
      wakeThreadSession(
        cliApi(),
        { sessionKey: "agent:main:discord:channel:T1", message: "Report.", timeout: "7000" },
        false,
      ),
    ).rejects.toThrow("gateway refused");
  });
});

describe("thread-handoff list rendering", () => {
  it("renders JSON without starter text while preserving handoff metadata", () => {
    const record = handoff({
      starterText: "private starter text",
      state: "claimed",
      claimedAt: 2_000,
      claimedBy: { sessionId: "target-uuid", runId: "run-1" },
    });
    const output = renderHandoffs([record], true);
    const { starterText, ...metadata } = record;
    expect(JSON.parse(output)).toEqual([metadata]);
    expect(output).not.toContain(starterText);
    expect(record.starterText).toBe(starterText);
    expect(JSON.parse(output)[0].claimedBy).toEqual({
      sessionId: "target-uuid",
      runId: "run-1",
    });
  });

  it("renders attempt counts in text output", () => {
    expect(renderHandoffs([handoff({ attemptCount: 3 })], false)).toContain("3 attempts");
  });
});

describe("thread-handoff receipt rendering", () => {
  it("renders empty JSON and text output", () => {
    expect(renderReceipts([], true)).toBe("[]");
    expect(renderReceipts([], false)).toBe("No active receipts.");
  });

  it("renders JSON without starter text", () => {
    const output = renderReceipts(
      [
        receipt(),
        receipt({
          receiptKey: "receipt-2",
          threadId: "200.300",
          starterMessageId: undefined,
        }),
      ],
      true,
    );
    expect(JSON.parse(output)).toEqual([
      {
        sessionKey: receipt().sessionKey,
        sessionId: receipt().sessionId,
        threadId: receipt().threadId,
        starterMessageId: receipt().starterMessageId,
        createdAt: receipt().createdAt,
        expiresAt: receipt().expiresAt,
      },
      {
        sessionKey: receipt().sessionKey,
        sessionId: receipt().sessionId,
        threadId: "200.300",
        createdAt: receipt().createdAt,
        expiresAt: receipt().expiresAt,
      },
    ]);
    expect(output).not.toContain(receipt().starterText);
  });

  it("renders tab-separated text without starter text", () => {
    const records = [
      receipt(),
      receipt({ receiptKey: "receipt-2", threadId: "200.300", starterMessageId: undefined }),
    ];
    const output = renderReceipts(records, false);
    expect(output).toBe(
      `${records[0].sessionKey}\t100.200\t100.201\t1000\t3601000\n${records[1].sessionKey}\t200.300\t-\t1000\t3601000`,
    );
    expect(output).not.toContain(receipt().starterText);
  });
});

function cliApi(): OpenClawPluginApi {
  return {
    runtime: {
      config: { current: () => ({ agents: { defaults: { timeoutSeconds: 90 } } }) },
      agent: { resolveAgentTimeoutMs: vi.fn(() => 90_000) },
    },
  } as unknown as OpenClawPluginApi;
}
