# @paleo/openclaw-discord-mock

Synthetic Discord-shaped OpenClaw channel plugin. Registers as channel `discord-mock`. Full Discord-shaped action surface: `send`, `thread-create`, `thread-reply`, `react`, `read`, `edit`, `delete`, `search`. `thread-create` posts an optional `text` / `message` / `content` atomically with the new thread; free-form agent text without a tool call lands in the parent channel.

Backed by [`@paleo/openclaw-channel-mock-core`](https://www.npmjs.com/package/@paleo/openclaw-channel-mock-core) (`surface: "discord"`, `autoThread: false`). Pair with [`@paleo/openclaw-test`](https://www.npmjs.com/package/@paleo/openclaw-test) for the QA harness.

## Install

```sh
npm i -D @paleo/openclaw-discord-mock
```

The runner depends on this package transitively — installing `@paleo/openclaw-test` already pulls it in.

## Enable

In your `openclaw.json`:

```json
{
  "plugins": {
    "load": { "paths": ["/opt/qa-src/node_modules/@paleo/openclaw-discord-mock"] },
    "entries": { "discord-mock": { "enabled": true } }
  },
  "channels": {
    "discord-mock": {
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

`Provider` / `Surface` / `OriginatingChannel` on inbound metadata are claimed as `discord-mock` so the SDK routes tool-schema discovery to this plugin. The `chat_id` envelope shape is **not** rewritten — assert on `conversation.id` / `threadId`.

## Attribution

Adapted from upstream OpenClaw's `extensions/discord/` plugin shape (manifest + entry points only). See [`NOTICE.md`](NOTICE.md).
