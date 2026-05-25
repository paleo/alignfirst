# @paleo/openclaw-test

Dockerised regression-test harness for OpenClaw workspaces. Drives the agent through two synthetic channels (`discord-mock`, `slack-mock`) and asserts the results.

Pair with [`@paleo/openclaw-channel-mock-core`](https://www.npmjs.com/package/@paleo/openclaw-channel-mock-core), [`@paleo/openclaw-discord-mock`](https://www.npmjs.com/package/@paleo/openclaw-discord-mock), [`@paleo/openclaw-slack-mock`](https://www.npmjs.com/package/@paleo/openclaw-slack-mock).

For internals (topology, Dockerfile pair, mocked-CLI shim, channel plugin mechanics, OpenClaw quirks), see [openclaw-test-architecture.md](https://github.com/paleo/alignfirst/blob/main/docs/openclaw-test-architecture.md).

## Install

```sh
npm i -D @paleo/openclaw-test @paleo/openclaw-channel-mock-core @paleo/openclaw-discord-mock @paleo/openclaw-slack-mock openclaw
```

Requires Docker Compose v2.20+ (overlay uses Compose `include:`).

Wire `package.json` scripts:

```json
"scripts": {
  "env:build": "openclaw-test env build",
  "env:up":    "openclaw-test env up",
  "env:down":  "openclaw-test env down",
  "qa":       "openclaw-test qa"
}
```

## Init

```sh
npx @paleo/openclaw-test init <qa-dir>
```

Drops four files:

- `openclaw.json` — gateway config (mode `local`, both channel plugins enabled, main agent placeholder).
- `.env.local.example` — copy to `.env.local`, fill `ANTHROPIC_API_KEY` + `OPENCLAW_WORKSPACE_DIR`.
- `docker-compose.yml` — thin overlay that `include:`s the base from `node_modules/`.
- `Dockerfile` — consumer-owned. Inherits the base via `FROM paleo/openclaw-test-base:${QA_RUNNER_BASE_TAG}`. Add `RUN`/`COPY`/`ENV` for consumer-specific setup (extra system packages, skills install, etc.).

## Configure

Edit `openclaw.json`:

- `agents.list[id=main].model` — LiteLLM-style `provider/model` ref. The template ships a placeholder; OpenClaw fails loudly until you pick one.
- `agents.list[id=main].workspace` — host path to your OpenClaw workspace, bind-mounted into the gateway. Field name is **`workspace`**, not `workspaceDir`.
- `channels.*` — both `discord-mock` and `slack-mock` blocks point at the same bus.

Drop scenarios under `scenarios/<id>.ts`. Project fixtures and their reset logic are consumer concerns — ship a reset script in your consumer image and invoke it from scenarios via `ctx.execInGateway(...)`. See [openclaw-test-architecture.md](https://github.com/paleo/alignfirst/blob/main/docs/openclaw-test-architecture.md) for the exec RPC contract.

Scenarios are loaded by Node 24's built-in TypeScript stripping. Stick to the strip-compatible subset (no `enum`, `namespace`, decorators, ctor parameter properties, `import =`). Shared helpers go under `scenarios/_lib/` — `discoverScenarios()` skips directories.

## Env vars (`.env.local`)

Required:

- `ANTHROPIC_API_KEY`
- `OPENCLAW_WORKSPACE_DIR` — host path mounted at `/home/claw/.openclaw/workspace`.

Optional (defaults relative to the consumer's `qa/` dir):

- `OPENCLAW_CONFIG_PATH` → `./openclaw.json`
- `QA_SCENARIOS_DIR` → `./scenarios`
- `QA_ARTIFACTS_DIR` → `./artifacts`
- `QA_GATEWAY_LOGS_DIR` → `./.gateway-logs`
- `OPENCLAW_RAW_STREAM=1` — also write `raw-stream.jsonl` alongside the always-on `anthropic-payload.jsonl`.

`QA_PROJECT_DIR`, `QA_RUNNER_PACKAGE_DIR`, `CLAW_UID`, `CLAW_GID` are injected by the CLI.

## Consumer Dockerfile responsibilities

The base image ships only Node, the mock-cli shim binary, and the exec watcher. Your consumer `Dockerfile` adds whatever the fixture needs:

- Install runtime tools your scripts/agents shell out to (e.g. `RUN apk add --no-cache git`, `RUN corepack enable && corepack prepare pnpm@latest --activate`).
- Create the per-command mock-cli symlinks you want intercepted, e.g. `RUN for name in claude gh; do ln -sf mock-cli-shim "/opt/qa-mocks/bin/$name"; done`.
- Ship any reset/seed scripts you'll invoke via `ctx.execInGateway(...)` (e.g. `COPY qa-scripts/ /opt/qa-scripts/`).
- Declare per-fixture named volumes in your compose overlay (e.g. a `qa-projects` volume mounted at `/home/claw/projects`).

## Run

```sh
npm run env:build                                                  # build base + consumer image
npm run qa -- --channel all <scenario>                             # one scenario, both channels
npm run qa -- --channel all --all                                  # every scenario, both channels
npm run qa -- --channel discord-mock <scenario>                    # restrict to one channel
npm run qa -- --channel all --iterations 5 <scenario>              # repeat each (scenario, channel) pair 5×
npm run qa -- --channel all --iterations 5 --max-failures 1 <s>    # abort a pair after >1 failure
npm run qa -- --channel discord-mock --reuse-stack <s>             # skip per-cell bus+gateway recreation
npm run env:up                                                     # (optional) keep bus + gateway warm across iterative runs
npm run env:down                                                   # tear down a warm stack
```

`qa` auto-starts `bus` + `gateway` via Docker Compose if they aren't running, and auto-`down`s them after the run completes. If you've explicitly run `env:up` beforehand, `qa` leaves the stack up so subsequent runs are fast. Ctrl-C is forwarded to the running container; auto-`down` still runs.

**Per-cell hygiene.** The host owns the matrix loop. Between cells (`scenario × channel × iteration`) it issues `docker compose up -d --force-recreate --wait bus gateway`, replacing both containers — the gateway for fresh in-process state, the bus to drop any cross-cell event history. The first cell skips recreation only when `qa` itself just brought the stack up (`wereUpBefore === false`). Realistic per-cell recreation overhead: 10–25 s on a healthy box; up to ~40 s under load. `--reuse-stack` opts out entirely (fast, but only safe when you vouch for no cross-cell state leak).

`env:build` first builds the base image (`paleo/openclaw-test-base:<pkg-version>`) from this package's `Dockerfile.base`, then builds the consumer image. Layer cache makes repeat base builds near-free; `env:up` / `qa` skip the base build when the tag already exists.

Rebuild required after: bumping any `@paleo/openclaw-*` dependency, edits to `openclaw.json`, or any change to the consumer `Dockerfile`.

Scenarios run **serially** through one gateway. Exit 0 iff every pair passes.

## Scenario primitives

From `@paleo/openclaw-test` (`src/context.ts`):

- `channel`, `conversationId`, `accountId` — per-task isolation. Use `ctx.conversationId` everywhere; never hard-code a value.
- `sendInbound(input)` → `{ message, entry }`. Push an inbound on the bus; `entry` is the `inboundSent` `ActionEntry` to which assertions/logs can be attached.
- `poll`, `expectNoOutbound` — bus consumers.
- `waitForOutbound(predicate, opts)` → `{ match, entry, nextCursor }`. `entry` is the `outboundReceived` `ActionEntry`; pass it as `attachTo` to bind judges and attached logs to that specific outbound. Two fail-fast signals are on by default; pass `false` per option to disable:
  - `failFastUnmatchedOutbounds` (default `3`) — fail when this many outbounds arrive without satisfying the predicate.
  - `failFastCliMockGraceMs` (default `10_000`) — fail when this long elapses after the most recent `cliMock` with no matching outbound. Each new `cliMock` resets the timer.
- `assertRegex`, `assertEqual`, `assertLength` — structural assertions. Silent on success; on failure, the assertion record and a `failure` field land on the **current entry** (most recent agent-action entry).
- `judgeLLM({ attachTo?, message, rubric, label })` — Anthropic-direct judgement. Pass `attachTo: entry` to bind the result to a specific action; otherwise it attaches to the **current entry**. `inboundSent` (scenario-emitted) never becomes the current entry — only agent-action entries (`outboundReceived`, `cliMock`, `agentToolCall`) do.
- `mockCli(name, handler)` — intercepts the gateway's calls to `git` / `npm` / `pnpm` / `yarn` / `claude`. Unregistered calls fail the scenario with `failure.source = "cliMock"`.
- `execInGateway(argv, { cwd?, env?, stdin?, timeoutMs? })` → `{ exitCode, stdout, stderr }`. Runs a command inside the gateway container via the exec watcher. Always resolves on completion (non-zero exits do not throw); throws only on transport failure or hard timeout. Typical use: invoke a consumer-shipped reset script (`/opt/qa-scripts/reset-fixture.mjs`) at the top of a scenario.
- `log(message)` or `log({ attachTo, prefix, message })` — free-standing `scenarioLog` entry, or a `scenarioLog` note attached to an action entry.
- `getCursor`.

Prefer structural assertions over `judgeLLM`; reserve the judge for free-form content claims.

**Rule of thumb**: when in doubt, pass `attachTo` explicitly. Use the entry returned by `waitForOutbound` / `sendInbound`, or snapshot `ctx.currentEntry` synchronously after the relevant `await` resolves and hand that snapshot to the judge call.

## Judge model

Defaults to `anthropic/claude-haiku-4-5`. Override via `QA_JUDGE_MODEL` on the `runner` service (set in your consumer overlay). The ref must be LiteLLM-style; only the `anthropic/` provider is wired up today. The judge is **not** an OpenClaw agent — don't configure it in `openclaw.json`.

## Artifacts

`artifacts/<runStamp>/<scenario>-<channel>[-<NN>][-<VERDICT>]/`:

- `scenario-log.jsonl` — appended live (one `ReportEntry` per line), survives a runner crash. Re-emits an entry every time a nested field is added; last write wins per `seq`.
- `report.json` — final `ScenarioReport`. Merges `scenario-log.jsonl` with `agentToolCall` entries from the gateway payload log; adds per-scenario `cost`.

`<NN>` is the iteration index (omitted when `--iterations 1`). `<VERDICT>` is `PASS` / `FAIL`, applied by **renaming the directory** after `report.json` is written. A directory with no verdict suffix means the run is pending or crashed before rename.

Each cell also writes `artifacts/<runStamp>/cells/<scenario>-<channel>[-<NN>].json` (the `CellResult` host-aggregation contract — `schemaVersion: 1`, verdict, cost, durations, judge usages). The host loop reads these to produce the summary and total-cost lines independently of the artifact-dir rename. A missing or invalid file counts the cell as a failure with a logged warning.

Authoritative types: `src/report.ts`.

## Channels

Both `discord-mock` and `slack-mock` register on every boot. Pick which to drive per scenario via `--channel discord-mock|slack-mock|all`.

- `discord-mock` — full Discord-shaped surface; `thread-create` posts an optional body atomically.
- `slack-mock` — restricted Slack-shaped surface (`react` / `read` / `edit` / `delete` / `reactions` / `search`). Bare-channel inbounds auto-thread on the triggering message.

Inbound metadata claims `Provider` / `Surface` / `OriginatingChannel` = the registered channel id so the SDK routes tool-schema discovery to the right plugin. Assert on `conversation.id` / `threadId`, not envelope formatting.

## Target format

Canonical destination param is `to`. Accepted shapes:

- `channel:<id>` or bare `<id>` (channel)
- `dm:<id>`
- `group:<id>`
- `thread:<channelId>/<threadId>`

Actions resolve `to → target → channelId`.

## Attribution

The runner package contains no upstream-adapted code. See sibling packages' `NOTICE.md` for OpenClaw attribution covering the channel plugins.
