# @paleo/openclaw-channel-mock-core

Shared library powering the synthetic OpenClaw channel plugins used in test harnesses. Provides the bus client, action handlers, account / inbound / outbound primitives, plugin and setup factories, and the typebox-based config schema.

Not meant to be consumed directly. Use the surface wrappers:

- [`@paleo/openclaw-discord-mock`](https://www.npmjs.com/package/@paleo/openclaw-discord-mock) — `surface: "discord"`, full action surface, `autoThread: false`.
- [`@paleo/openclaw-slack-mock`](https://www.npmjs.com/package/@paleo/openclaw-slack-mock) — `surface: "slack"`, restricted action surface, `autoThread: true`.

Both wrappers register as OpenClaw channels and talk to a single bus (`http://bus:43123` by default) provisioned by [`@paleo/openclaw-test`](https://www.npmjs.com/package/@paleo/openclaw-test).

Slack supports `replyToMode: "off" | "all"`, including account overrides. The default `"all"`
routes an eligible root and its replies to one thread session keyed by the root message ID. `"off"`
keeps roots in the channel session while explicit thread replies use their canonical thread
session. Slack `send` and Discord `thread-create` return native-shaped delivery receipts so gateway
plugins can distinguish confirmed, failed, and partial starter delivery.

Test scenarios can arm one recoverable transport fault with
`failNextQaBusOperation({ baseUrl, operation: "outbound-message" | "thread-create" })`. The bus
consumes it before side effects, so a retry can prove that only one native starter exists.

`zod` is a peer dependency pinned to OpenClaw's own version: the config schema composes OpenClaw's zod objects with locally built ones, so both must resolve to the same zod instance. When upgrading OpenClaw, move the peer pin to whatever zod version the new OpenClaw release pins.

## Attribution

Adapted from upstream OpenClaw's `extensions/qa-channel/`. See [`NOTICE.md`](NOTICE.md).
