# @paleo/openclaw-slack-mock

Synthetic Slack-shaped OpenClaw channel plugin. Registers as channel `slack-mock`. Its
Slack-shaped action surface includes `send`, `read`, `edit`, `delete`, `react`, `reactions`, and
`search`; fake thread creation, replies, and renames stay unavailable. `send` returns Slack's native
`{ ok: true, result: { messageId, channelId, threadTs? } }` receipt shape and preserves starter text
exactly.

Backed by [`@paleo/openclaw-channel-mock-core`](https://www.npmjs.com/package/@paleo/openclaw-channel-mock-core) (`surface: "slack"`, `autoThread: true`). Pair with [`@paleo/openclaw-test`](https://www.npmjs.com/package/@paleo/openclaw-test) for the test harness.

## Install

```sh
npm i -D @paleo/openclaw-slack-mock
```

The runner depends on this package transitively — installing `@paleo/openclaw-test` already pulls it in.

## Enable

In your `openclaw.json`:

```json
{
  "plugins": {
    "load": { "paths": ["/opt/openclaw-test/src/node_modules/@paleo/openclaw-slack-mock"] },
    "entries": { "slack-mock": { "enabled": true } }
  },
  "channels": {
    "slack-mock": {
      "baseUrl": "http://bus:43123",
      "botUserId": "openclaw",
      "botDisplayName": "OpenClaw Test",
      "allowFrom": ["*"],
      "replyToMode": "off"
    }
  }
}
```

`enabled: true` must be **static**. Auto-enable for `origin: "config"` plugins is timing-sensitive against the plan-resolution `explicitlyEnabled` check.

`replyToMode` supports `"off"` and `"all"`. The default is `"all"` for compatibility: an eligible
root message routes through a thread session keyed by that root message ID, and later replies use
the same session. With `"off"`, roots use the channel session and explicit replies use a thread
session. Account-level configuration may override the top-level mode.

## Target format

Canonical destination is the `to` param. Accepts `channel:<id>` / bare `<id>` / `dm:<id>` / `group:<id>` / `thread:<channelId>/<threadId>`.

`Provider` / `Surface` / `OriginatingChannel` on inbound metadata are claimed as `slack-mock` so the SDK routes tool-schema discovery to this plugin. The `chat_id` envelope shape is **not** rewritten — assert on `conversation.id` / `threadId`.

## Attribution

Adapted from upstream OpenClaw's `extensions/slack/` plugin shape (manifest + entry points only). See [`NOTICE.md`](NOTICE.md).
