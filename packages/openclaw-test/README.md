# @paleo/openclaw-test

Dockerised regression-test harness for OpenClaw workspaces. Drives the agent through two synthetic channels (`discord-mock`, `slack-mock`) and asserts the results.

Pair with [`@paleo/openclaw-channel-mock-core`](https://www.npmjs.com/package/@paleo/openclaw-channel-mock-core), [`@paleo/openclaw-discord-mock`](https://www.npmjs.com/package/@paleo/openclaw-discord-mock), [`@paleo/openclaw-slack-mock`](https://www.npmjs.com/package/@paleo/openclaw-slack-mock).

For internals (topology, Dockerfile pair, mocked-CLI shim, channel plugin mechanics, OpenClaw quirks), see [openclaw-test-architecture.md](https://github.com/paleo/alignfirst/blob/main/docs/openclaw-test-architecture.md).

## Install

```sh
npm i -D @paleo/openclaw-test @paleo/openclaw-channel-mock-core @paleo/openclaw-discord-mock @paleo/openclaw-slack-mock openclaw
```

Requires Docker Compose.

## Init

```sh
npx @paleo/openclaw-test init <project-dir>
```

Adds the four `package.json` scripts (`env:build`, `env:up`, `env:down`, `e2e`) if missing, and drops four files:

- `openclaw.json` — gateway config (mode `local`, both channel plugins enabled, main agent placeholder).
- `.env.local.example` — copy to `.env.local` and fill in; its comments document every variable.
- `docker-compose.yml` — thin overlay that `include:`s the base stack from `node_modules/`.
- `Dockerfile` — consumer-owned; its comments document the common customizations (system tools, mock-CLI symlinks, fixtures, reset scripts).

## Configure

Edit `openclaw.json`:

- `agents.entries.main.model` — default `provider/model` ref; `run --model` overrides it per run.
- `agents.entries.main.workspace` — host path to your OpenClaw workspace. Field name is **`workspace`**, not `workspaceDir`.
- `channels.slack-mock.blockStreaming: true` — set this when running Slack scenarios under auto-thread, otherwise the agent's reply dribbles into the thread token-by-token.

## Env vars (`.env.local`)

```sh
ANTHROPIC_API_KEY=sk-ant-…
OPENCLAW_WORKSPACE_DIR=/path/to/your/openclaw-workspace

# Model catalog: full LiteLLM refs. `run --model` picks by bare id (suffix after the last "/").
OPENCLAW_TEST_MODELS=anthropic/claude-sonnet-4-6,custom-openrouter/qwen/qwen3.6-plus
OPENCLAW_DEFAULT_TEST_MODEL=claude-sonnet-4-6

# Required only when running an OpenRouter model.
OPENROUTER_API_KEY=
```

See `.env.local.example` for the optional overrides (paths, raw stream log).

## Scenarios

Drop scenarios under `scenarios/<id>.ts`: each default-exports `async (ctx: ScenarioContext) => void`. They are loaded by Node's built-in TypeScript stripping: no `enum`, `namespace`, decorators, ctor parameter properties. Shared helpers must go under subdirectories (e.g. `scenarios/_lib/`).

Project fixtures and their reset logic are consumer concerns — ship a reset script in your consumer image and invoke it via `ctx.execInGateway(...)`.

`ScenarioContext` primitives (authoritative types: `src/context.ts`):

- `channel`, `conversationId`, `accountId` — per-task isolation; never hard-code a conversation id.
- `sendInbound(input)` — push an inbound message on the bus.
- `waitForOutbound(predicate, opts)` — await a matching outbound; fails fast on unmatched outbounds or mock-CLI silence.
- `poll`, `expectNoOutbound`, `getCursor` — bus consumers.
- `assertRegex`, `assertEqual`, `assertLength` — structural assertions.
- `judgeLLM({ message, rubric, label, attachTo? })` — LLM judgement, bound to an action entry.
- `mockCli(name, handler)` — intercept the gateway's CLI calls (`git`, `claude`, …); unregistered calls fail the scenario.
- `execInGateway(argv, opts)` — run a command inside the gateway container.
- `log(...)` — scenario log entry, free-standing or attached to an action.

Prefer structural assertions over `judgeLLM`; reserve the judge for free-form content claims.

Examples: [alignfirst-developer-tests/scenarios](https://github.com/paleo/alignfirst/tree/main/alignfirst-developer-tests/scenarios).

## Run

```sh
npm run env:build                                                  # build base + consumer image
npm run env:up                                                     # (optional) keep bus + gateway warm across iterative runs
npm run e2e -- --channel all <scenario>                             # one scenario, both channels
npm run e2e -- --channel all --all                                  # every scenario, both channels
npm run e2e -- --channel discord-mock <scenario>                    # restrict to one channel
npm run e2e -- --channel all --model qwen3.6-plus <scenario>        # pick a model by bare id
npm run e2e -- --channel all --model claude-sonnet-4-6,qwen3.6-plus <s>  # a comma list of bare ids
npm run e2e -- --channel all --model all <scenario>                 # run every model in OPENCLAW_TEST_MODELS
npm run e2e -- --channel all --iterations 5 <scenario>              # repeat each (scenario, channel) pair 5×
npm run e2e -- --channel all --iterations 5 --max-failures 1 <s>    # abort a pair after >1 failure
npm run e2e -- --channel all --iterations 10 --parallel 4 <s>       # run up to 4 cells concurrently
npm run e2e -- --channel discord-mock --reuse-stack <s>             # skip per-cell bus+gateway recreation
npm run env:down                                                   # tear down all worker stacks
```

`run` auto-starts the worker stacks it needs and tears down the ones it started; an explicit `env:up` beforehand keeps them warm across runs.

Rebuild (`npm run env:build`) after editing `openclaw.json` or the `Dockerfile`, or after bumping any `@paleo/openclaw-*` dependency.

Cells run serially per worker stack. Exit 0 iff every pair passes. Artifacts land under `artifacts/<runStamp>/` — see the [architecture doc](https://github.com/paleo/alignfirst/blob/main/docs/openclaw-test-architecture.md).

### Parallel runs

`--parallel K` (default `OPENCLAW_TEST_PARALLEL` from `.env.local`, fallback 1; the flag wins) runs up to K cells concurrently, each on its own worker Compose stack — project `<project>-w<i>`, all sharing one image. Iterations of one pair parallelize too, so flakiness measurements (`--iterations N`) are the primary win. With K > 1, per-cell output is captured to `artifacts/<runStamp>/cells/<leaf>.log` and the console shows one compact line per cell event.

Each worker gets its own gateway logs dir (`.gateway-logs/w<i>/`) and a private workspace copy under `.workers/`, refreshed from `OPENCLAW_WORKSPACE_DIR` before every cell. Add `.workers/` to your `.gitignore` and `.dockerignore`.

`env up -- --parallel K` pre-warms K workers. `env down` takes no flag: it discovers every `<project>-w<N>` stack and tears them all down, including orphans from a crashed run.

**Upgrading from a pre-parallel version:** stacks now run under per-worker Compose project names, so the old un-suffixed project is orphaned. Tear it down once with `docker compose down` from the project dir.

## Channels

- `discord-mock` — full Discord-shaped surface; no auto-thread.
- `slack-mock` — restricted Slack-shaped surface (`react` / `read` / `edit` / `delete` / `reactions` / `search`); bare-channel inbounds auto-thread on the triggering message.

Assert on `conversation.id` / `threadId`, not envelope formatting.

## Judge model

Defaults to `anthropic/claude-haiku-4-5`. Override via `OPENCLAW_TEST_JUDGE_MODEL` on the `runner` service (set in your consumer overlay). The judge is **not** an OpenClaw agent — don't configure it in `openclaw.json`.

## Attribution

The runner package contains no upstream-adapted code. See sibling packages' `NOTICE.md` for OpenClaw attribution covering the channel plugins.
