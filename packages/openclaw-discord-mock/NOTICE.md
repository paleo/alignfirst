# NOTICE — upstream attribution

Thin Discord-shaped wrapper around `@paleo/openclaw-channel-mock-core`. The plugin shape (manifest + entry points) follows upstream [OpenClaw](https://github.com/steipete/openclaw) `extensions/discord/` (MIT, Copyright 2025 Peter Steinberger).

## Shape borrowed from `openclaw/extensions/discord/`

- `channel-plugin-api.ts` → `src/channel-plugin-api.ts`
- `setup-plugin-api.ts` → `src/channel-setup-plugin.ts`
- `setup-entry.ts` → `src/setup-entry.ts`
- `index.ts` → `src/index.ts`
- `runtime-api.ts` → `src/runtime.ts`
- `openclaw.plugin.json` → `openclaw.plugin.json`

The Discord-specific transport implementation is **not** copied; this package delegates to the channel-mock core with `surface: "discord"` and `autoThread: false`.

See [`LICENSE`](LICENSE) for the combined MIT license text (Paleo + upstream OpenClaw attribution).
