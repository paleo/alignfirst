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

npm install
npm run env:build
npm run env:up
npm run e2e -- --channel all --all
npm run env:down
```

See the upstream README for all flags.

> ⚠️ **Never `rm -rf artifacts` (or `.gateway-logs`).** Each run lands in its own **timestamped** subdir, so runs accumulate without colliding — deleting the directory throws away prior runs you may still need. These are bind-mount outputs; leave them in place.

## Configuration

- `OPENCLAW_WORKSPACE_DIR=./workspace` — the `myclaw` workspace, bind-mounted into the gateway. Workspace edits iterate live.
- `ALIGNFIRST_COACHING_SKILL_DIR` — host path to the `alignfirst-coaching` skill, bind-mounted into the gateway. Playbook edits iterate live, no rebuild.
- `OPENCLAW_CODER_PLAYBOOK_SKILL_DIR` — host path to the `openclaw-coder-playbook` skill, bind-mounted into the gateway. Playbook edits iterate live, no rebuild.
- [`openclaw.json`](openclaw.json) — `tools.profile=coding` + `alsoAllow=["message"]`, `agents.defaults.skills=["alignfirst","alignfirst-coaching"]`, `blockStreaming*` defaults, main agent model `anthropic/claude-sonnet-4-6`, `channels.*.botDisplayName="myclaw"`.
- [`docker-compose.yml`](docker-compose.yml) — `fixture-projects` named volume on gateway + runner at `/home/claw/projects`; the skill bind mount on `gateway`; `OPENCLAW_TEST_JUDGE_MODEL=anthropic/claude-haiku-4-5` on `runner`.

## Fixtures

Each scenario starts fresh: [`scripts/reset-fixture.mjs`](scripts/reset-fixture.mjs) (run via `ctx.execInGateway(...)`) materializes two git repos on branch `develop` at `/home/claw/projects/{nimbus,lumen}`, both copied from the committed [`projects-fixture/template/`](projects-fixture/template/) — a minimal Express monorepo stand-in. Each carries `package.json` `name` `@playbook-test/<name>-fixture` and `welcome.md` H1 `# Welcome to <Name>`.

## Scenarios

Drop `scenarios/<id>.ts`, default-export `async (ctx: ScenarioContext) => void`. Shared helpers under `scenarios/_lib/` (skipped by the runner's discovery). Current scenarios: `A1`–`A9`.

**Ticket-id convention:** scenario `A<S>` uses `ABC-0<S>N` (`A1` → `ABC-010`, `A2` → `ABC-020`, …). The mechanical mapping is a leak signal: while running `A<S>`, any `ABC-0<X>N` with `X ≠ S` is bleed from another scenario. The test sender is `ROBIN01` (a `tech` user in [`workspace/USER.md`](workspace/USER.md)). A5's `aurora` is deliberately **not** a fixture name (unknown-project path).

## Editable upstream packages (optional fall-back)

`@paleo/openclaw-*` ship from npmjs. To test unreleased changes from this monorepo, swap a dependency to `file:../../packages/<pkg>`, then `npm install && npm run env:build`. Revert before committing.

## Layout

- [`openclaw.json`](openclaw.json) · [`docker-compose.yml`](docker-compose.yml) · [`Dockerfile`](Dockerfile) · [`package.json`](package.json) — committed.
- `.env.local` (gitignored) — `ANTHROPIC_API_KEY`, `DASHSCOPE_API_KEY` (only for a Qwen run), `OPENCLAW_WORKSPACE_DIR`, `ALIGNFIRST_COACHING_SKILL_DIR`, `OPENCLAW_CODER_PLAYBOOK_SKILL_DIR`.
- `artifacts/` (gitignored) — per-run outputs.
- `.gateway-logs/` (gitignored) — `trajectory/<sessionId>.jsonl` (always, provider-neutral), `raw-stream.jsonl` (opt-in).
