# @paleo/openclaw-qa-runner

Dockerised regression-test harness for OpenClaw workspaces. Drives the agent through two synthetic channels (`discord-mock`, `slack-mock`) and asserts the results. One gateway, one bus, parallel scenarios.

Toolkit entry point. Pair with [`@paleo/openclaw-channel-mock-core`](../openclaw-channel-mock-core/), [`@paleo/openclaw-discord-mock`](../openclaw-discord-mock/), [`@paleo/openclaw-slack-mock`](../openclaw-slack-mock/).

## Install

```sh
npm i -D @paleo/openclaw-qa-runner @paleo/openclaw-channel-mock-core @paleo/openclaw-discord-mock @paleo/openclaw-slack-mock openclaw
```

Requires Docker Compose v2.20+ (consumer overlay uses Compose `include:`).

## Init

```sh
npx openclaw-qa-runner init .
```

Drops three files into the target directory:

- `openclaw.json` — gateway config (mode `local`, both channel plugins enabled, main + judge agents).
- `.env.local.example` — copy to `.env.local`, set `ANTHROPIC_API_KEY`.
- `docker-compose.yml` — thin overlay that `include:`s this package's base stack from `node_modules/`.

Then wire `package.json` scripts (`env:build`, `env:up`, `env:down`, `qa`) — see the templates and the consumer guide below.

## Configure

Edit `openclaw.json`:

- `agents.list[id=main].workspace` — host path to your OpenClaw workspace (bind-mounted into the gateway).
- `agents.list[id=judge]` — model for the LLM judge; defaults to a cheap Haiku.
- `channels.*` — both `discord-mock` and `slack-mock` blocks point at the same bus.

Drop scenarios under `scenarios/<id>.ts`, default-export `async (ctx: ScenarioContext) => void`. Project fixtures live under `projects-fixture/` (bind-mounted to `~/projects/`).

Scenarios are loaded at runtime by Node's built-in TypeScript stripping (Node 24, which the image uses). Stick to the strip-compatible subset: type annotations, `as`, `satisfies`, generics, interfaces. Avoid `enum`, `namespace`, constructor parameter properties, decorators, and `import =`.

## Build / up / run

```sh
npm run env:build                                 # build the gateway / bus / runner image
npm run env:up                                    # bring up bus + gateway (both channels register)
npm run qa -- --channel all <scenario>            # one scenario, both channels in parallel
npm run qa -- --channel all --all                 # every scenario, both channels
npm run qa -- --channel discord-mock <scenario>   # restrict to one channel
npm run env:down
```

`--concurrency N` (default 4, env `QA_CONCURRENCY`) caps fanout. Artifacts under `artifacts/<baseStamp>-<scenario>-<channel>/`. Exit 0 iff every task passes.

## Scenario primitives

From `@paleo/openclaw-qa-runner` (`src/context.ts`):

- `channel`, `conversationId`, `accountId` — per-task isolation. Use `ctx.conversationId` everywhere; never hard-code a value.
- `sendInbound(text, opts?)` — push an inbound on the bus.
- `poll(opts?)`, `waitForOutbound(opts?)`, `expectNoOutbound(opts?)` — bus consumers.
- `assertRegex`, `assertEqual`, `assertLength` — structural assertions.
- `judgeLLM(prompt)` — Anthropic-direct judgement (no bus traffic).
- `log`, `getCursor`.

Prefer structural assertions over `judgeLLM`; reserve the judge for free-form content claims.

## Channels

Both plugins register together. Pick which to drive per scenario via `--channel discord-mock|slack-mock|all`.

- `discord-mock` — full Discord-shaped surface; `thread-create` posts an optional body atomically.
- `slack-mock` — restricted Slack-shaped surface (`react` / `read` / `edit` / `delete` / `reactions` / `search`). Bare-channel inbounds auto-thread on the triggering message.

## Compose stack

`docker-compose.yml` is parameterized via env vars (the consumer-side `bin/qa` and `bin/env-up` set them):

- `QA_PROJECT_DIR` — consumer's `qa/` (build context, working dir).
- `QA_RUNNER_PACKAGE_DIR` — host path to this package (mounts `dist/` and `workspace-judge/`; rebuild with `npm run build` to refresh).
- `OPENCLAW_WORKSPACE_DIR` — mounted at `/home/kclaw/.openclaw/workspace`.
- `OPENCLAW_CONFIG_PATH` — mounted at `/home/kclaw/.openclaw/openclaw.json`.
- `PROJECTS_DIR` — mounted at `/home/kclaw/projects/`.
- `SCENARIOS_DIR` — mounted at `/opt/qa-src/scenarios`.
- `ARTIFACTS_DIR` — mounted at `/opt/qa-artifacts`.
- `GATEWAY_LOGS_DIR` — mounted at `/home/kclaw/.openclaw/logs`.
- `KCLAW_UID` / `KCLAW_GID` — propagated to the image so artifacts land owned by the host user.

Healthchecks: `gateway` waits on `bus`, `runner` waits on `gateway`.

## Gateway logs (opt-in)

Set in `.env.local`:

```sh
OPENCLAW_ANTHROPIC_PAYLOAD_LOG=1
OPENCLAW_RAW_STREAM=1
```

Writes `anthropic-payload.jsonl` and `raw-stream.jsonl` under `.gateway-logs/`. The runner's cost reporting reads `anthropic-payload.jsonl`.

## Attribution

The runner package contains no upstream-adapted code. See sibling packages' `NOTICE.md` for OpenClaw attribution covering the channel plugins.
