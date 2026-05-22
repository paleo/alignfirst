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

- `openclaw.json` — gateway config (mode `local`, both channel plugins enabled, main agent).
- `.env.local.example` — copy to `.env.local`, set `ANTHROPIC_API_KEY`.
- `docker-compose.yml` — thin overlay that `include:`s this package's base stack from `node_modules/`.

Then wire `package.json` scripts:

```json
"scripts": {
  "env:build": "openclaw-qa-runner env build",
  "env:up":    "openclaw-qa-runner env up",
  "env:down":  "openclaw-qa-runner env down",
  "qa":       "openclaw-qa-runner qa"
}
```

Each command derives `QA_PROJECT_DIR` from `cwd`, `QA_RUNNER_PACKAGE_DIR` from its own install location, and `CLAW_UID`/`CLAW_GID` from the host user — no boilerplate in `package.json`.

## Configure

Edit `openclaw.json`:

- `agents.list[id=main].model` — LiteLLM-style `provider/model` ref (e.g. `anthropic/claude-sonnet-4-6`). The template ships a placeholder; OpenClaw will fail loudly until you pick one.
- `agents.list[id=main].workspace` — host path to your OpenClaw workspace (bind-mounted into the gateway).
- `channels.*` — both `discord-mock` and `slack-mock` blocks point at the same bus.

The LLM judge runs out-of-process — Anthropic-direct from the runner, never through the gateway — so it is **not** an OpenClaw agent and is not configured via `openclaw.json`. Defaults to `anthropic/claude-haiku-4-5`; override via the `QA_JUDGE_MODEL` env var on the runner. The ref must be LiteLLM-style; only the `anthropic/` provider is wired up today.

Drop scenarios under `scenarios/<id>.ts`, default-export `async (ctx: ScenarioContext) => void`. Project fixtures live under `projects-fixture/` (bind-mounted to `~/projects/`).

Scenarios are loaded at runtime by Node's built-in TypeScript stripping (Node 24, which the image uses). Stick to the strip-compatible subset: type annotations, `as`, `satisfies`, generics, interfaces. Avoid `enum`, `namespace`, constructor parameter properties, decorators, and `import =`.

## Build / up / run

```sh
npm run env:build                                                  # build the gateway / bus / runner image
npm run env:up                                                     # bring up bus + gateway (both channels register)
npm run qa -- --channel all <scenario>                             # one scenario, both channels
npm run qa -- --channel all --all                                  # every scenario, both channels
npm run qa -- --channel discord-mock <scenario>                    # restrict to one channel
npm run qa -- --channel all --iterations 5 <scenario>              # repeat each (scenario, channel) pair 5 times
npm run qa -- --channel all --iterations 5 --max-failures 1 <s>    # abort a pair after >1 failure
npm run env:down
```

`--concurrency N` (default 4, env `QA_CONCURRENCY`) caps fanout. Artifacts land under `artifacts/<runStamp>/<scenario>-<channel>[-<NN>][-<VERDICT>]/`: `<NN>` is the iteration index (omitted when `--iterations 1`), `<VERDICT>` is `PASS` / `FAIL`, applied by renaming the dir after `report.json` is written — its absence means the run is still pending or crashed before rename. Exit 0 iff every pair passes.

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

The CLI sets `QA_PROJECT_DIR`, `QA_RUNNER_PACKAGE_DIR`, `CLAW_UID`, `CLAW_GID` automatically. Everything else comes from `.env.local`:

- `ANTHROPIC_API_KEY` — required.
- `OPENCLAW_WORKSPACE_DIR` — required (host path mounted at `/home/claw/.openclaw/workspace`).
- `OPENCLAW_CONFIG_PATH` — default `<qa>/openclaw.json` → `/home/claw/.openclaw/openclaw.json`.
- `QA_PROJECTS_DIR` — default `<qa>/projects-fixture` → `/home/claw/projects/`.
- `QA_SCENARIOS_DIR` — default `<qa>/scenarios` → `/opt/qa-src/scenarios`.
- `QA_ARTIFACTS_DIR` — default `<qa>/artifacts` → `/opt/qa-artifacts`.
- `QA_GATEWAY_LOGS_DIR` — default `<qa>/.gateway-logs` → `/home/claw/.openclaw/logs`.

`<qa>` is the consumer's qa dir (the wrapper's `cwd`). Rebuild this package's `dist/` with `npm run build` to refresh the mount.

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
