import {
  createChannelMockAccountHelpers,
  createChannelMockMessageActions,
} from "@paleo/openclaw-channel-mock-core";
import { describe, expect, it } from "vitest";

const CHANNEL_ID = "slack-mock";
const helpers = createChannelMockAccountHelpers({ channelId: CHANNEL_ID });
const actions = createChannelMockMessageActions({
  channelId: CHANNEL_ID,
  surface: "slack",
  helpers,
});

if (!actions.handleAction || !actions.describeMessageTool) {
  throw new Error("slack-mock actions missing handleAction/describeMessageTool");
}
const handleAction: NonNullable<typeof actions.handleAction> = actions.handleAction;
const describeMessageTool: NonNullable<typeof actions.describeMessageTool> =
  actions.describeMessageTool;

const cfg = {
  channels: {
    [CHANNEL_ID]: {
      baseUrl: "http://bus",
      botUserId: "openclaw",
      botDisplayName: "OpenClaw QA",
      allowFrom: ["*"],
    },
  },
};

describe("slack-mock action surface", () => {
  it("describeMessageTool exposes only read/edit/delete/react/reactions/search", () => {
    const desc = describeMessageTool({
      cfg: cfg as unknown as Parameters<typeof describeMessageTool>[0]["cfg"],
      accountId: "default",
    } as unknown as Parameters<typeof describeMessageTool>[0]);
    if (!desc) throw new Error("describeMessageTool returned no descriptor");
    const set = new Set(desc.actions);
    for (const wanted of ["read", "edit", "delete", "react", "reactions", "search"]) {
      expect(set.has(wanted as never)).toBe(true);
    }
    for (const forbidden of ["send", "thread-create", "thread-reply"]) {
      expect(set.has(forbidden as never)).toBe(false);
    }
  });

  it("rejects send / thread-create / thread-reply", async () => {
    const run = (action: string, params: Record<string, unknown>) =>
      handleAction({
        action,
        cfg: cfg as unknown as Parameters<typeof handleAction>[0]["cfg"],
        accountId: "default",
        params,
      } as unknown as Parameters<typeof handleAction>[0]);
    await expect(run("send", { to: "sample-project", text: "x" })).rejects.toThrow(
      /does not expose action/,
    );
    await expect(run("thread-create", { to: "sample-project", title: "x" })).rejects.toThrow(
      /does not expose action/,
    );
    await expect(
      run("thread-reply", { to: "sample-project", threadId: "T", text: "x" }),
    ).rejects.toThrow(/does not expose action/);
  });
});
