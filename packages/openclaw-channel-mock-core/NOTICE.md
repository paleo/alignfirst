# NOTICE — upstream attribution

This package adapts code from the upstream [OpenClaw](https://github.com/steipete/openclaw) `extensions/qa-channel/` extension (MIT, Copyright 2025 Peter Steinberger).

## Adapted from `openclaw/extensions/qa-channel/`

- `api.ts` → re-exported via `src/index.ts`
- `channel-plugin-api.ts` → `src/plugin.ts`
- `runtime-api.ts` → `src/runtime-api.ts`
- `setup-entry.ts` → upstream pattern reused by sibling wrapper packages
- `setup-plugin-api.ts` → `src/channel-setup-plugin.ts`

## Adapted from `openclaw/extensions/qa-channel/src/`

- `accounts.ts` → `src/accounts.ts`
- `bus-client.ts` → `src/bus-client.ts` (split into `bus-handler.ts`, `bus-queries.ts`, `bus-state.ts`, `bus-waiters.ts`)
- `channel-actions.ts` → `src/plugin-actions.ts`
- `channel.setup.ts` → `src/setup.ts`
- `channel.ts` → influenced `src/plugin.ts`
- `config-schema.ts` → `src/config-schema.ts`
- `gateway.ts` → `src/gateway.ts`
- `inbound.ts` → `src/inbound.ts`
- `outbound.ts` → `src/outbound.ts`
- `protocol.ts` → `src/protocol.ts`
- `runtime.ts` → `src/runtime.ts`
- `setup.ts` → `src/setup.ts`
- `status.ts` → `src/status.ts`
- `types.ts` → `src/types.ts`

See [`LICENSE`](LICENSE) for the combined MIT license text (Paleo + upstream OpenClaw attribution).
