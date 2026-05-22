# @paleo/openclaw-discord-mock

Synthetic Discord-shaped OpenClaw channel plugin. Registers as channel `discord-mock` with the full Discord action surface (`send`, `thread-create`, `thread-reply`, `react`, `read`, `edit`, `delete`, `search`). `thread-create` posts an optional body atomically with the new thread; free-form agent text without a tool call lands in the parent channel.

Backed by [`@paleo/openclaw-channel-mock-core`](../openclaw-channel-mock-core/) with `surface: "discord"` and `autoThread: false`. Pair with [`@paleo/openclaw-qa-runner`](../openclaw-qa-runner/) for the QA harness.

`Provider` / `Surface` / `OriginatingChannel` on inbound metadata are claimed as `discord-mock` so the SDK routes tool-schema discovery to this plugin.

## Attribution

Adapted from upstream OpenClaw's `extensions/discord/` plugin shape (manifest + entry points only). See [`NOTICE.md`](NOTICE.md).
