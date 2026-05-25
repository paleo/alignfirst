# @paleo/openclaw-channel-mock-core

Shared library powering the synthetic OpenClaw channel plugins used in QA harnesses. Provides the bus client, action handlers, account / inbound / outbound primitives, plugin and setup factories, and the typebox-based config schema.

Not meant to be consumed directly. Use the surface wrappers:

- [`@paleo/openclaw-discord-mock`](https://www.npmjs.com/package/@paleo/openclaw-discord-mock) — `surface: "discord"`, full action surface, `autoThread: false`.
- [`@paleo/openclaw-slack-mock`](https://www.npmjs.com/package/@paleo/openclaw-slack-mock) — `surface: "slack"`, restricted action surface, `autoThread: true`.

Both wrappers register as OpenClaw channels and talk to a single bus (`http://bus:43123` by default) provisioned by [`@paleo/openclaw-test`](https://www.npmjs.com/package/@paleo/openclaw-test).

## Attribution

Adapted from upstream OpenClaw's `extensions/qa-channel/`. See [`NOTICE.md`](NOTICE.md).
