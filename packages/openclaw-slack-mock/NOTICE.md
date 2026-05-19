# NOTICE — upstream attribution

Thin Slack-shaped wrapper around `@paleo/openclaw-channel-mock-core`. The plugin shape (manifest + entry points) follows upstream [OpenClaw](https://github.com/steipete/openclaw) `extensions/slack/` (MIT, Copyright 2025 Peter Steinberger).

## Shape borrowed from `openclaw/extensions/slack/`

- `channel-plugin-api.ts` → `src/channel-plugin-api.ts`
- `setup-plugin-api.ts` → `src/channel-setup-plugin.ts`
- `setup-entry.ts` → `src/setup-entry.ts`
- `index.ts` / `channel-entry.ts` → `src/index.ts`
- `runtime-api.ts` → `src/runtime.ts`
- `openclaw.plugin.json` → `openclaw.plugin.json`

The Slack-specific transport implementation is **not** copied; this package delegates to the channel-mock core with `surface: "slack"` and `autoThread: true`.

See [`LICENSE`](LICENSE) for the combined MIT license text (Paleo + upstream OpenClaw attribution).
