# playbook-test

Dockerised regression-test harness for the `myclaw` reference workspace at [`workspace/`](workspace/). Local-only. Manually run.

Standalone consumer of the published `@paleo/openclaw-*` packages (own `package-lock.json`, not part of the root npm workspaces). See upstream docs for the generic mechanics:

- [packages/openclaw-test/README.md](../../packages/openclaw-test/README.md) — install, configure, run, scenario primitives, artifact layout.
- [docs/openclaw-test-architecture.md](../../docs/openclaw-test-architecture.md) — internals.

This README only documents what is specific to this harness.

## Install & run

```sh
cp .env.local.example .env.local
# Edit .env.local — fill ANTHROPIC_API_KEY

# Build the real coaching CLI the gateway runs (packages/alcoach/dist must exist).
npm run build --workspace @paleo/alcoach --prefix ../..

npm install
npm run env:build
npm run env:up
npm run e2e -- --channel all --all
npm run env:down
```

See the upstream README for all flags.

> ℹ️ **Build `@paleo/alcoach` before `env:up`.** The gateway runs the real `alcoach` CLI
> (live-mounted from `ALCOACH_DIR`, host path to `packages/alcoach`) via a `/usr/local/bin/alcoach`
> wrapper — only its own `claude` subprocess is mocked. If `packages/alcoach/dist` is missing the
> wrapper fails at runtime. alcoach edits iterate live (no rebuild); a `tsc` rebuild of alcoach is
> enough.

> ⚠️ **Never `rm -rf artifacts` (or `.gateway-logs`).** Each run lands in its own **timestamped** subdir, so runs accumulate without colliding — deleting the directory throws away prior runs you may still need. These are bind-mount outputs; leave them in place.

## Configuration

- `OPENCLAW_WORKSPACE_DIR=./workspace` — the `myclaw` workspace, bind-mounted into the gateway. Workspace edits iterate live.
- `ALIGNFIRST_COACHING_SKILL_DIR` — host path to the `alignfirst-coaching` skill, bind-mounted into the gateway. Playbook edits iterate live, no rebuild.
- `OPENCLAW_CODER_PLAYBOOK_SKILL_DIR` — host path to the `openclaw-coder-playbook` skill, bind-mounted into the gateway. Playbook edits iterate live, no rebuild.
- `ALCOACH_DIR` — host path to `packages/alcoach` (build it first). Live-mounted read-only at `/opt/alcoach`; the `/usr/local/bin/alcoach` wrapper runs `node /opt/alcoach/bin/alcoach.mjs`. Not shimmed — alcoach runs for real; its `claude` subprocess still resolves to the mock via PATH order.
- [`openclaw.json`](openclaw.json) — `tools.profile=coding` + `alsoAllow=["message"]`, `agents.defaults.skills=["alignfirst","alignfirst-coaching"]`, `blockStreaming*` defaults, main agent model `anthropic/claude-sonnet-4-6`, `channels.*.botDisplayName="myclaw"`, and a `hooks` block (`enabled`, a `token`, `allowRequestSessionKey`, `allowedSessionKeyPrefixes`) so alcoach's completion callback can dispatch an agent turn.
- [`docker-compose.yml`](docker-compose.yml) — `fixture-projects` named volume on gateway + runner at `/home/claw/projects`; the skill + alcoach bind mounts on `gateway`; `ALCOACH_CALLBACK_URL`/`ALCOACH_CALLBACK_TOKEN` on `gateway` (points alcoach at the gateway's in-container `http://127.0.0.1:18789/hooks/agent`, token matching `hooks.token`); `OPENCLAW_TEST_JUDGE_MODEL=anthropic/claude-haiku-4-5` on `runner`.

## Coaching callback (alcoach)

The coaching flow runs the real `alcoach` CLI. When a callback URL resolves (`ALCOACH_CALLBACK_URL`), alcoach runs the coding session in the **background**: it returns immediately (`Started. Log: …`), runs `claude` as a detached child, and on completion `POST`s `{ sessionKey, message, idempotencyKey }` to the gateway's `/hooks/agent` endpoint (`Authorization: Bearer <token>`). OpenClaw dispatches an agent turn into that session (the `sessionKey` the agent captured via `session_status` and passed as `--session-key`), which resumes the thread and reports the outcome. The gateway serves `/hooks/*` on its own HTTP port (18789) in `gateway.mode: "local"`; `hooks.allowRequestSessionKey=true` lets the request-supplied `sessionKey` through, and `allowedSessionKeyPrefixes` scopes it to the agent's sessions (`agent:main:`) plus the `hook:` fallback the config validator requires.

## Fixtures

Each scenario starts fresh: [`scripts/reset-fixture.mjs`](scripts/reset-fixture.mjs) (run via `ctx.execInGateway(...)`) materializes two git repos on branch `develop` at `/home/claw/projects/{nimbus,lumen}`, both copied from the committed [`projects-fixture/template/`](projects-fixture/template/) — a minimal Express monorepo stand-in. Each carries `package.json` `name` `@playbook-test/<name>-fixture` and `DEVELOPMENT.md` H1 `# Developing <Name>`, plus an (untracked) `.plans/` directory so `alcoach`'s project gate is satisfied.

## Scenarios

Drop `scenarios/<id>.ts`, default-export `async (ctx: ScenarioContext) => void`. Shared helpers under `scenarios/_lib/` (skipped by the runner's discovery). Current scenarios: `A1`–`A10`. `A10` exercises the real `alcoach` background + `/hooks/agent` callback path (asserts the agent delegates to `alcoach`, not `claude`, then rides the callback-driven completion).

**Ticket-id convention:** scenario `A<S>` uses `ABC-0<S>N` (`A1` → `ABC-010`, `A2` → `ABC-020`, …; `A10` → `ABC-0100`). The mechanical mapping is a leak signal: while running `A<S>`, any `ABC-0<X>N` with `X ≠ S` is bleed from another scenario. The test sender is `ROBIN01` (a `tech` user in [`workspace/USER.md`](workspace/USER.md)). A5's `aurora` is deliberately **not** a fixture name (unknown-project path).

## Editable upstream packages (optional fall-back)

`@paleo/openclaw-*` ship from npmjs. To test unreleased changes from this monorepo, swap a dependency to `file:../../packages/<pkg>`, then `npm install && npm run env:build`. Revert before committing.

## Layout

- [`openclaw.json`](openclaw.json) · [`docker-compose.yml`](docker-compose.yml) · [`Dockerfile`](Dockerfile) · [`package.json`](package.json) — committed.
- `.env.local` (gitignored) — `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY` (only for a Qwen run), `OPENCLAW_WORKSPACE_DIR`, `ALIGNFIRST_COACHING_SKILL_DIR`, `OPENCLAW_CODER_PLAYBOOK_SKILL_DIR`, `ALCOACH_DIR`.
- `artifacts/` (gitignored) — per-run outputs.
- `.gateway-logs/` (gitignored) — `trajectory/<sessionId>.jsonl` (always, provider-neutral), `raw-stream.jsonl` (opt-in).
