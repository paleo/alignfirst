import { describe, expect, it } from "vitest";
import { createChannelMockPlugin } from "../src/plugin.js";

const schema = createChannelMockPlugin({
  channelId: "slack-mock",
  label: "Slack mock",
  surface: "slack",
  autoThread: true,
  getRuntime: () => {
    throw new Error("Config schema must not start the host runtime");
  },
}).configSchema;

describe("public channel mock config schema", () => {
  it("composes host tools policies with account and group settings", () => {
    const value = {
      baseUrl: "http://localhost:43123",
      pollTimeoutMs: 100,
      replyToMode: "off",
      defaultAccount: "test",
      groups: {
        general: {
          requireMention: false,
          tools: { allow: ["message"], deny: ["exec"] },
          toolsBySender: { "user:robin": { allow: ["read"] } },
        },
      },
      accounts: {
        test: {
          enabled: true,
          pollTimeoutMs: 30_000,
          replyToMode: "all",
          actions: { messages: true, reactions: true },
        },
      },
    };
    expect(schema?.runtime?.safeParse?.(value)).toMatchObject({ success: true, data: value });
  });

  it.each([
    { baseUrl: "invalid" },
    { pollTimeoutMs: 99 },
    { pollTimeoutMs: 30_001 },
    { pollTimeoutMs: 100.5 },
    { unknown: true },
    { accounts: { test: { unknown: true } } },
    { groups: { general: { unknown: true } } },
    { groups: { general: { toolsBySender: { robin: { allow: "exec" } } } } },
    { replyToMode: "first" },
  ])("rejects invalid config %j", (value) => {
    expect(schema?.runtime?.safeParse?.(value)).toMatchObject({ success: false });
  });

  it("exports concrete JSON schema using the host's Zod conversion context", () => {
    expect(schema?.schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        baseUrl: { type: "string", format: "uri" },
        pollTimeoutMs: { type: "integer", minimum: 100, maximum: 30_000 },
        replyToMode: { enum: ["off", "all"] },
        groups: { type: "object" },
        accounts: { type: "object" },
      },
    });
    expect(JSON.stringify(schema?.schema)).toContain("toolsBySender");
  });
});
