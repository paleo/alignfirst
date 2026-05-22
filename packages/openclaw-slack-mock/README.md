# @paleo/openclaw-slack-mock

Synthetic Slack-shaped OpenClaw channel plugin. Registers as channel `slack-mock` with a restricted action surface (`read`, `edit`, `delete`, `react`, `reactions`, `search`). No `send` / `thread-create` / `thread-reply`. Bare-channel inbounds auto-thread: the first agent outbound creates a thread anchored on the inbound message id; every subsequent outbound from that turn lands in the same thread.

Backed by [`@paleo/openclaw-channel-mock-core`](../openclaw-channel-mock-core/) with `surface: "slack"` and `autoThread: true`. Pair with [`@paleo/openclaw-qa-runner`](../openclaw-qa-runner/) for the QA harness.

`Provider` / `Surface` / `OriginatingChannel` on inbound metadata are claimed as `slack-mock` so the SDK routes tool-schema discovery to this plugin.

## Attribution

Adapted from upstream OpenClaw's `extensions/slack/` plugin shape (manifest + entry points only). See [`NOTICE.md`](NOTICE.md).
