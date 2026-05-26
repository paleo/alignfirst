---
title: OpenClaw Test Harness Architecture
summary: How the four `@paleo/openclaw-*` packages fit together — bus, gateway, runner, channel plugins, mocked CLIs, artifact layout, and the OpenClaw quirks the harness papers over.
read_when:
  - onboarding to the test-runner codebase
  - debugging a scenario that misbehaves at the harness layer
  - touching the Compose stack, the Dockerfile pair, or the mocked-CLI shim
  - extending a channel plugin or adding a new one
---

# OpenClaw Test Harness Architecture

Four packages drive automated regression tests against an OpenClaw workspace. Consumers depend on all four; only `openclaw-test` is the entry point.

| Package | Role |
| --- | --- |
| `@paleo/openclaw-test` | Bus, scenario driver, judge, Compose stack, two-Dockerfile pair, CLI (`init` / `env` / `run`). |
| `@paleo/openclaw-channel-mock-core` | Shared channel library — bus client, action handlers, plugin/setup factories, account helpers. Not consumed directly. |
| `@paleo/openclaw-discord-mock` | Thin wrapper. Registers as channel `discord-mock`, `surface: "discord"`, `autoThread: false`. |
| `@paleo/openclaw-slack-mock` | Thin wrapper. Registers as channel `slack-mock`, `surface: "slack"`, `autoThread: true`. |

The two wrappers exist side-by-side in one gateway and share a single bus. The runner picks which channel(s) to drive per scenario; `accountId = channelId` keeps per-channel bus state segregated.

## Service topology

Three Compose services. All three are built from the **same image** — only the `command` differs.

```
            ┌─────────┐
inbound ──▶ │   bus   │ ◀── outbound (every channel plugin)
            └────┬────┘
                 │ HTTP :43123
       ┌─────────┴─────────┐
       │                   │
   ┌───▼───┐           ┌───▼────┐
   │gateway│           │ runner │
   └───┬───┘           └───┬────┘
       │ exec()            │ POST :43124 /mock-cli/invoke
       ▼                   ▲
   /opt/openclaw-test/mocks/bin ──────┘   (gateway-side shim)
```

- **`bus`** — in-memory state store. Conversations, threads, messages, events, cursors. Exposes a small HTTP API consumed by `bus-client.ts` in `channel-mock-core`.
- **`gateway`** — runs `npx openclaw gateway run`. Loads both channel plugins via `plugins.load.paths`. Talks to the bus through its channel plugins; talks to the runner through the mocked-CLI shim.
- **`runner`** — runs scenarios serially. Mints a fresh `conversationId` per task, pushes inbounds onto the bus, polls outbounds, asserts, runs the judge (Anthropic-direct), writes artifacts.

Healthchecks gate `gateway` on `bus`, and the one-shot `runner` invocation on `gateway`. `runner` is started with `docker compose run --rm --use-aliases runner`; without `--use-aliases` the one-shot container has no network alias and the gateway-side shim's `POST http://runner:43124` fails with `getaddrinfo EAI_AGAIN runner`.

## Two-Dockerfile pattern

`openclaw-test` ships `Dockerfile.base` (consumer-agnostic): Node 24 Alpine, `claw` user with host-matched UID/GID, the mock-CLI **shim binary** at `/opt/openclaw-test/mocks/bin/mock-cli-shim` (no per-command symlinks — consumers add their own), `/etc/profile` rewritten to keep `/opt/openclaw-test/mocks/bin` first in PATH, and the exec watcher binary at `/usr/local/bin/exec-watcher`. Anything else the fixture needs at runtime (`git`, `pnpm` via Corepack, reset scripts, per-command shim symlinks) is the consumer's responsibility.

The CLI's `env build` builds the base locally as `paleo/openclaw-test-base:<pkg-version>` and injects the tag into the consumer image via the `OPENCLAW_TEST_BASE_TAG` build arg.

The consumer-owned `Dockerfile` (dropped by `init`) does:

1. `FROM paleo/openclaw-test-base:${OPENCLAW_TEST_BASE_TAG}`
2. `COPY` the consumer's `package.json` + `package-lock.json` and `openclaw.json` into the image.
3. `npm ci --include=dev` — pulls the four `@paleo/openclaw-*` packages from the registry.
4. `npx openclaw plugins registry --refresh` so the gateway sees the loaded channels.
5. Optional consumer customizations (extra system packages, skills install, etc.).

`openclaw-test run` does **not** rebuild. Re-run `npm run env:build` after edits to `openclaw.json` or the consumer `Dockerfile`, or after bumping any `@paleo/openclaw-*` dependency.

`Dockerfile.base` overrides `/etc/profile`. OpenClaw's `exec` tool spawns `/bin/sh -lc <command>`, which sources `/etc/profile`. Alpine's stock profile resets PATH to a "safe" default that drops `/opt/openclaw-test/mocks/bin`, silently bypassing the shim — so only commands missing from the default PATH (e.g. `git`, not installed in Alpine) would end up shimmed. Overriding the profile keeps the shim first for every command.

## Compose include

The consumer ships a thin overlay that pulls in the package's base stack:

```yaml
include:
  - ./node_modules/@paleo/openclaw-test/docker-compose.yml
```

Compose v2.20+ required. The overlay's job is to add consumer-specific service overrides (e.g. extra env vars on `runner`); the base file owns the build context, volumes, healthchecks, and entrypoints.

Path-shaped vars from `.env.local` (`OPENCLAW_WORKSPACE_DIR`, `OPENCLAW_CONFIG_PATH`, `OPENCLAW_TEST_SCENARIOS_DIR`, `OPENCLAW_TEST_ARTIFACTS_DIR`, `OPENCLAW_TEST_GATEWAY_LOGS_DIR`) are resolved by the CLI against the consumer's `cwd` before invoking Compose — otherwise Compose `include:` would resolve them relative to the package's compose file under `node_modules/`, breaking natural relative paths.

The CLI injects `OPENCLAW_TEST_PROJECT_DIR`, `OPENCLAW_TEST_PACKAGE_DIR`, `CLAW_UID`, `CLAW_GID` automatically.

## Mocked-CLI shim

The gateway's PATH is prepended at runtime with `/opt/openclaw-test/mocks/bin/`, where consumer-created symlinks (e.g. `claude`, `gh`) point at one Node shim. The base image ships only the shim binary; each consumer adds the per-command symlinks it wants intercepted (typical line in the consumer Dockerfile: `RUN for name in claude gh; do ln -sf mock-cli-shim "/opt/openclaw-test/mocks/bin/$name"; done`). The shim POSTs to `http://runner:43124/mock-cli/invoke` with `{ cli, argv, cwd, stdin }` and replays the JSON response (`{ stdout, stderr, exitCode }`).

The sh wrapper at `/opt/openclaw-test/mocks/bin/mock-cli-shim` invokes the shim as `node mock-cli-shim.js "$0" "$@"`. The JS reads the symlink name from `argv[2]` (`/opt/openclaw-test/mocks/bin/git` → `git`). Without `"$0"`, the shim would see only the script path and reject every call as `unexpected call to mock-cli-shim.js`.

PATH prepend happens only at gateway runtime — the image build's own `npm install` still uses real `npm`.

Scenarios register handlers via `ctx.mockCli(name, handler)`. Return value: number → exit code; `void`/`undefined` → 0; throw → exit 1 with `handlerError` recorded. Re-registering the same name in one scenario throws. Any invocation with no matching handler **fails the scenario** with `failure.source = "cliMock"` and `message = "unexpected call to <cli>"`, even if no assertion ever ran after.

The runner binds a single in-flight `ConversationRegistry` per scenario; scenarios run serially through one gateway. Each invocation emits a `cliMock` `ReportEvent` carrying the full `CliMockCall` (argv, cwd, stdin, stdout, stderr, exitCode, durationMs, optional handlerError).

## Per-scenario isolation

Cross-cell hygiene is enforced at the container level (see "Per-cell hygiene" below); within one cell, the only isolation between tasks is the `conversationId` — minted fresh per task as `${scenarioId}-${channel}-${shortRand}` and exposed as `ctx.conversationId`. Scenarios must use `ctx.conversationId` everywhere they currently hard-code a value; metadata that needs to identify the project (e.g. a workspace playbook keying off project name) belongs in the inbound *text*, not in the conversation id.

The mock-cli `release()` quiet-drain is no longer load-bearing across cells (the host destroys the gateway container between them); it remains as a small belt-and-braces for the post-`markScenarioAsEnded` window inside one cell.

The harness does **not** provide a fixture reset. Scenarios that need to wipe and reseed on-disk state (e.g. a project tree under `/home/claw/projects/`) ship a reset script in the consumer image and invoke it via `ctx.execInGateway(...)`. The harness owns only the transport.

## Per-cell hygiene

The host CLI owns the matrix loop: each `(scenario, channel, iterationIndex)` cell is one `docker compose run --rm runner --scenario … --channel … --iteration-index …` invocation. Between cells the host issues `docker compose up -d --force-recreate --wait bus gateway`, recreating both containers in a single Compose call (`--wait` blocks on healthchecks). Recreation drops in-process gateway state, the bus's in-memory event log, transient container `/tmp` files, and on-process caches that survive a SIGTERM-only restart. The first cell skips recreation when `run` itself just brought the stack up; subsequent cells always recreate. `--reuse-stack` opts out entirely.

The `openclaw-test-ipc` named volume survives container recreation, so `exec-watcher` sweeps stale `*.req.json` / `*.req.json.processing` / `*.res.json` on startup. The runner writes a `CellResult` JSON to `<artifacts>/<baseStamp>/cells/<scenario>-<channel>[-<iter>].json` before renaming its artifact dir; the host reads these to drive the matrix-level summary and total-cost lines. Missing/invalid file → cell counted as fail, warning logged, loop continues. Per-pair `--max-failures` bail is enforced host-side.

## Exec RPC

`ctx.execInGateway(argv, opts)` is the only way to run code inside the gateway container's PID namespace from a scenario. Implementation:

- A shared named volume `openclaw-test-ipc` is mounted at `/var/run/openclaw-test-ipc` on both `gateway` and `runner`.
- The gateway boots `/usr/local/bin/exec-watcher` (Node, stdlib only) in the background. The watcher polls `/var/run/openclaw-test-ipc/*.req.json` every 100 ms, atomically claims each request via `rename` to `<id>.req.json.processing`, spawns the wrapped command, and writes `<id>.res.json` atomically (`*.tmp` → `rename`).
- The runner writes the request (`{ id, argv, cwd?, env?, stdin?, timeoutMs }`) atomically and polls for the response, bounded by `timeoutMs + 5_000 ms`.
- stdout/stderr are buffered separately, capped at 1 MiB each, with a `\n…[truncated NN bytes]` marker on overflow.
- The watcher enforces `timeoutMs` (default 30 s) and on expiry SIGKILLs the child, recording `exitCode: 124`.
- Non-zero exits do **not** throw on the caller side. The caller decides how to interpret them.
- Internal watcher failure still emits a response (`exitCode: 255`) so the runner never hangs.

## Channel plugin internals

Each wrapper exposes two entries in its `package.json`:

- `openclaw.extensions` → `dist/index.js` — the runtime channel plugin (`defineBundledChannelEntry`).
- `openclaw.setupEntry` → `dist/setup-entry.js` — a setup-only plugin (`defineBundledChannelSetupEntry`).

Both are required. Without `openclaw.setupEntry`, the loader registers the plugin but `resolvePluginRegistrationPlan` skips the `setup-runtime` mode and the channel pipeline never calls `gateway.startAccount`. The setup plugin is a subset of the runtime plugin (`id`, `meta`, `capabilities`, `reload`, `configSchema`, `setup`, `config` — no `messaging` / `gateway` / `actions` / `message`); the loader's `mergeSetupRuntimeChannelPlugin` fills the rest at runtime.

Discovery is wired through `plugins.load.paths` in `openclaw.json`, pointing at the package directory inside the image (`/opt/openclaw-test/src/node_modules/@paleo/openclaw-{discord,slack}-mock`). Both plugins must be statically enabled via `plugins.entries["<id>"].enabled = true` — auto-enable for non-bundled (`origin: "config"`) plugins is timing-sensitive against `canStartConfiguredChannelPlugin`: the auto-enable mutation can fire after plan resolution checks `explicitlyEnabled`. Static `enabled: true` makes the check deterministic.

Both channels register together on every gateway boot. The runner selects which to drive per scenario. The runner accepts any channel id declared in `openclaw.json`'s `channels` block — pass `--channel <id>`, a comma-separated list `--channel id1,id2`, or `--channel all` to fan out across every declared channel.

`createChannelMockPlugin` in `channel-mock-core` takes `{ channelId, label, surface, autoThread, getRuntime }`. The two wrappers are ten-line modules that bind these knobs:

- `discord-mock` — `surface: "discord"`, `autoThread: false`. Full Discord-shaped surface (`send`, `thread-create`, `thread-reply`, `react`, `read`, `edit`, `delete`, `search`). `thread-create` posts an optional `text`/`message`/`content` atomically with the new thread. Free-form agent text without a tool call lands in the parent channel.
- `slack-mock` — `surface: "slack"`, `autoThread: true`. Restricted surface (`react` / `read` / `edit` / `delete` / `reactions` / `search`). Bare-channel inbounds auto-thread on the triggering message; every subsequent outbound from the same turn lands in that thread.

Inbound metadata claims `Provider` / `Surface` / `OriginatingChannel` = the registered channel id, so the SDK routes tool-schema discovery back to the right plugin. `chat_id` envelope shape is **not** rewritten — scenarios assert on `conversation.id` / `threadId`, not envelope formatting.

Each `openclaw.plugin.json` declares a minimal `channelConfigs.<id>.schema` (`type: "object"`, `additionalProperties: true`) to silence the gateway's `channel plugin manifest declares <id> without channelConfigs metadata` warning. The static schema is intentionally permissive — the runtime plugin owns the real config schema via `buildChannelMockConfigSchema`. `label` / `selectionLabel` / `docsPath` / `blurb` still come from the runtime plugin.

## Target normalizer + plugin-action vs send

OpenClaw's `normalizeMessageActionInput` runs before any `"to"`-mode plugin handler (`send`, `thread-create`, `thread-reply`, `react`, `read`, `edit`, `delete`). It rewrites `channelId` → `target` → `to` and deletes the original `channelId` key. A handler that reads `channelId` directly is broken-by-construction. `channel-mock-core`'s `resolveDestination` always reads `to` first.

Canonical destination param is `to`. Accepted shapes:

- `channel:<id>` or bare `<id>` (channel)
- `dm:<id>`
- `group:<id>`
- `thread:<channelId>/<threadId>`

Resolved in the order `to → target → channelId` to match the normalizer's output.

Plugin actions and `send` route through different handlers in `message-action-runner.ts`. Only `send` triggers the delivery mirror, which historically tripped a lock-fence race (`EmbeddedAttemptSessionTakeoverError`). Plugin actions don't set `ctx.mirror` and never trip the race. Workspace-driven outbound that needs a thread should use `thread-create` + `thread-reply` rather than `send`.

`BindingMatchSchema` is strict-equality on `peer.id`. No catch-all binding without multi-account channel config. The judge agent (in OpenClaw config) is left config-only and never instantiated; the actual judge runs out-of-process from the runner against Anthropic directly.

## Artifacts & cost

Layout: `artifacts/<runStamp>/<scenario>-<channel>[-<NN>][-<VERDICT>]/`.

- `<NN>` — iteration index, padded to the width of `--iterations`. Omitted when `--iterations 1`.
- `<VERDICT>` — `PASS` / `FAIL`. Applied by **renaming the directory** after `report.json` lands. A directory with no verdict suffix means the run is pending or crashed before the rename.

Two files per task:

- `scenario-log.jsonl` — appended live as the scenario runs, one `ReportEntry` per line, plus `{ entrySeq, augment }` patch lines whenever a nested field (`assertions`, `scenarioLog`, `failure`) is added to an existing entry. Readers fold patches onto entries by `entrySeq`; last write wins. `agentToolCall` entries are appended at the tail in `ts` order with `entrySeq` values continuing past the live entries'. Full tool result `content` is preserved here — never truncated.
- `report.json` — final `ScenarioReport`, written once at end. Merges live entries with `agentToolCall` entries and sorts the array by `ts`. `entrySeq` is the same identifier the jsonl uses, so a failure pointing at `entrySeq: 7` resolves to the same entry in both files. Long string `content` on `agentToolCall.result` is replaced by `truncatedContent` (60 chars + `…`) for compactness; the jsonl keeps the full value. Adds per-scenario `cost = { gatewayUsd, judgeUsd, totalUsd, gatewayTurns }`.

Scenario verdict is reported as `result: ScenarioResult` (a discriminated union):

- `{ verdict: "pass" }` — clean run.
- `{ verdict: "fail", cause: "failedEntry", entrySeq, message }` — failure landed on an action entry; details live on the entry with the matching `entrySeq` (find it via `entries.find(e => e.entrySeq === N)`, not by array index).
- `{ verdict: "fail", cause: "error", source, errorName, message, stack? }` — failure with no associated entry (timeout before any agent action, runner error, etc.).

Entry kinds: `scenarioLog` · `inboundSent` · `outboundReceived` · `cliMock` · `agentToolCall`. Each entry is one action; assertions, scenario-log notes, and failures live as nested fields (`assertions: AssertionRecord[]`, `scenarioLog: ScenarioLogNote`, `failure: ScenarioFailure`) on the action entry they describe. `outboundReceived` captures every bus outbound for the conversation, not only the ones the scenario explicitly awaits. `agentToolCall` lives only in `report.json`.

Scenarios bind judges and attached logs to a specific action entry via `attachTo`:

```ts
const wait = await ctx.waitForOutbound(predicate, opts);
ctx.log({ attachTo: wait.entry, prefix: "follow-up received", message: wait.match.text });
await ctx.judgeLLM({ attachTo: wait.entry, message: wait.match.text, rubric, label });
```

Without `attachTo`, judges and other attachments fall back to the **current entry** — the most recently emitted agent-action entry (`outboundReceived` or `cliMock` / `agentToolCall`). `inboundSent` is scenario-emitted and does not update the current entry, so a `judgeLLM` call after `ctx.sendInbound(...)` still binds to whatever agent action preceded the inbound. Internal asserts (`assertRegex` / `assertEqual` / `assertLength`) are silent on success and only surface on failure — their `failure` lands on the current entry.

Authoritative types: `packages/openclaw-test/src/report.ts`.

Cost: the runner sums the gateway's `stage:"usage"` entries from `anthropic-payload.jsonl` for any entry with `ts >= runStart`, plus the judge's inline `usage` priced via an in-runner table. A 5s grace wait after the last task lets OpenClaw flush its usage record (it lands ~2s after the outbound hits the bus). Failing runs that time out before the agent completes report `$0.0000` — the gateway never wrote a usage record for the unfinished turn.

`OPENCLAW_ANTHROPIC_PAYLOAD_LOG=1` is forced on by the Compose stack — tests need the file. `OPENCLAW_RAW_STREAM=1` is opt-in for `raw-stream.jsonl`. Both land under `.gateway-logs/` (bind-mounted from `~/.openclaw/logs/`).

## Judge

`judgeLLM` calls Anthropic directly from the runner — no bus traffic, no gateway involvement. Not an OpenClaw agent. Model defaults to `anthropic/claude-haiku-4-5`; override via `OPENCLAW_TEST_JUDGE_MODEL` on the runner service. LiteLLM-style ref required; only the `anthropic/` provider is wired up today.

Prefer structural assertions over `judgeLLM`; reserve the judge for free-form content claims.

## OpenClaw config quirks the harness depends on

- **`agents.list[*].workspace`, not `workspaceDir`.** The schema accepts both spellings on related surfaces, but the agents list only reads `workspace`.
- **`gateway.mode: "local"` required.** Without it, startup fails with `existing config is missing gateway.mode`.

## Scenario loading

Scenarios are `.ts` files under `scenarios/`, default-export `async (ctx: ScenarioContext) => void`. Loaded at runtime by Node 24's built-in TypeScript stripping (the image uses Node 24). Stick to the strip-compatible subset: type annotations, `as`, `satisfies`, generics, interfaces. Avoid `enum`, `namespace`, constructor parameter properties, decorators, `import =`.

`discoverScenarios()` filters on `.ts` suffix on file entries only — directories under `scenarios/` (e.g. `_lib/`) are ignored, which is the idiomatic place for shared scenario helpers.

## See also

- Each package's `README.md` — actionable usage.
- `packages/openclaw-test/src/context.ts` — `ScenarioContext` definition.
- `packages/openclaw-test/src/report.ts` — authoritative event/report types.
