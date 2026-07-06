import { describe, expect, it } from "vitest";
import { resolveHistoryScope } from "../src/plugin-actions.js";

describe("resolveHistoryScope", () => {
  it("parses a composite thread target passed as threadId (envelope chat_id shape)", () => {
    const scope = resolveHistoryScope({ threadId: "thread:conv-1/conv-1-thread-abc", limit: 50 });
    expect(scope).toEqual({ conversationId: "conv-1", threadId: "conv-1-thread-abc" });
  });

  it("keeps a bare threadId as the thread filter", () => {
    expect(resolveHistoryScope({ threadId: "conv-1-thread-abc" })).toEqual({
      threadId: "conv-1-thread-abc",
    });
  });

  it("takes the thread id carried by a thread-shaped destination", () => {
    expect(resolveHistoryScope({ to: "thread:conv-1/conv-1-thread-abc" })).toEqual({
      conversationId: "conv-1",
      threadId: "conv-1-thread-abc",
    });
  });

  it("combines a channel destination with a bare threadId", () => {
    expect(resolveHistoryScope({ channelId: "conv-1", threadId: "conv-1-thread-abc" })).toEqual({
      conversationId: "conv-1",
      threadId: "conv-1-thread-abc",
    });
  });

  it("treats a channel-prefixed threadId as a conversation scope", () => {
    expect(resolveHistoryScope({ threadId: "channel:conv-1-thread-abc" })).toEqual({
      conversationId: "conv-1-thread-abc",
    });
  });

  it("falls back to the current channel when no scope params are given", () => {
    expect(resolveHistoryScope({ limit: 20 }, "thread:conv-1/conv-1-thread-abc")).toEqual({
      conversationId: "conv-1",
      threadId: "conv-1-thread-abc",
    });
    expect(resolveHistoryScope({}, "conv-1")).toEqual({ conversationId: "conv-1" });
  });

  it("ignores the current channel when params already scope the read", () => {
    expect(resolveHistoryScope({ threadId: "t-1" }, "channel:other")).toEqual({ threadId: "t-1" });
  });

  it("resolves to an empty scope when nothing is given", () => {
    expect(resolveHistoryScope({})).toEqual({});
  });
});
