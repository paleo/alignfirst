# @paleo/openclaw-slack-mock

Synthetic Slack-shaped OpenClaw channel plugin. Registers as channel `slack-mock`. Restricted Slack-shaped action surface: `read`, `edit`, `delete`, `react`, `reactions`, `search`. No `send` / `thread-create` / `thread-reply`. Bare-channel inbounds auto-thread: the first agent outbound creates a thread anchored on the inbound message id; every subsequent outbound from the same turn lands in that thread.

Backed by [`@paleo/openclaw-channel-mock-core`](https://www.npmjs.com/package/@paleo/openclaw-channel-mock-core) (`surface: "slack"`, `autoThread: true`). Pair with [`@paleo/openclaw-qa-runner`](https://www.npmjs.com/package/@paleo/openclaw-qa-runner) for the QA harness.

## Install

```sh
npm i -D @paleo/openclaw-slack-mock
```

The runner depends on this package transitively — installing `@paleo/openclaw-qa-runner` already pulls it in.

## Enable

In your `openclaw.json`:

```json
{
  "plugins": {
    "load": { "paths": ["/opt/qa-src/node_modules/@paleo/openclaw-slack-mock"] },
    "entries": { "slack-mock": { "enabled": true } }
  },
  "channels": {
    "slack-mock": {
      "baseUrl": "http://bus:43123",
      "botUserId": "openclaw",
      "botDisplayName": "OpenClaw QA",
      "allowFrom": ["*"]
    }
  }
}
```

`enabled: true` must be **static**. Auto-enable for `origin: "config"` plugins is timing-sensitive against the plan-resolution `explicitlyEnabled` check.

## Target format

Canonical destination is the `to` param. Accepts `channel:<id>` / bare `<id>` / `dm:<id>` / `group:<id>` / `thread:<channelId>/<threadId>`.

`Provider` / `Surface` / `OriginatingChannel` on inbound metadata are claimed as `slack-mock` so the SDK routes tool-schema discovery to this plugin. The `chat_id` envelope shape is **not** rewritten — assert on `conversation.id` / `threadId`.

## Attribution

Adapted from upstream OpenClaw's `extensions/slack/` plugin shape (manifest + entry points only). See [`NOTICE.md`](NOTICE.md).
