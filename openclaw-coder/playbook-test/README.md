# playbook-test

Dockerised regression-test harness for the `myclaw` reference workspace at [`../workspace/`](../workspace/). Local-only. Manually run.

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

## Configuration

- `OPENCLAW_WORKSPACE_DIR=../workspace` — the `myclaw` workspace, bind-mounted into the gateway. Workspace edits iterate live.
- `ALIGNFIRST_AGENT_SKILL_DIR` (default `../../skills/alignfirst-agent`) — the `alignfirst-agent` skill, bind-mounted over the gateway's baked copy at `/home/claw/.agents/skills/alignfirst-agent`. **Playbook edits iterate without an image rebuild** — just rerun a scenario. The baked copy (from the `skills add` step in the [`Dockerfile`](Dockerfile)) is the fallback when the mount is absent.
- [`openclaw.json`](openclaw.json) — `tools.profile=coding` + `alsoAllow=["message"]`, `agents.defaults.skills=["alignfirst","alignfirst-agent"]`, `blockStreaming*` defaults, main agent model `anthropic/claude-sonnet-4-6`, `channels.*.botDisplayName="myclaw"`.
- [`docker-compose.yml`](docker-compose.yml) — `fixture-projects` named volume on gateway + runner at `/home/claw/projects`; the skill bind mount on `gateway`; `OPENCLAW_TEST_JUDGE_MODEL=anthropic/claude-haiku-4-5` on `runner`.

## Fixtures

One committed template, [`projects-fixture/template/`](projects-fixture/template/) — a minimal Express stand-in for a product monorepo. Baked into the image at `/opt/playbook-test/fixtures/template/` with a single `pnpm install --frozen-lockfile`.

[`scripts/reset-fixture.mjs`](scripts/reset-fixture.mjs) (invoked from each scenario via `ctx.execInGateway(...)`) materializes **two** distinct projects from that one template — `nimbus` and `lumen`. For each: wipe, copy the template into `/home/claw/projects/<name>`, patch `package.json` `name` → `@playbook-test/<name>-fixture` and the `welcome.md` H1 → `# Welcome to <Name>`, then `git init -b develop` + initial commit. Patching only the `name` field keeps the frozen lockfile valid, so a single build-time install serves both.

## Scenarios

Drop `scenarios/<id>.ts`, default-export `async (ctx: ScenarioContext) => void`. Shared helpers under `scenarios/_lib/` (skipped by the runner's discovery). Current scenarios: `A1`–`A9`.

**Ticket-id convention:** scenario `A<S>` uses `ABC-0<S>N` (`A1` → `ABC-010`, `A2` → `ABC-020`, …). The mechanical mapping is a leak signal: while running `A<S>`, any `ABC-0<X>N` with `X ≠ S` is bleed from another scenario. The test sender is `QAUSER01` (a `tech` user in [`../workspace/USER.md`](../workspace/USER.md)). A5's `aurora` is deliberately **not** a fixture name (unknown-project path).

## Editable upstream packages (optional fall-back)

`@paleo/openclaw-*` ship from npmjs. To test unreleased changes from this monorepo, swap a dependency to `file:../../packages/<pkg>`, then `npm install && npm run env:build`. Revert before committing.

## Layout

- [`openclaw.json`](openclaw.json) · [`docker-compose.yml`](docker-compose.yml) · [`Dockerfile`](Dockerfile) · [`package.json`](package.json) — committed.
- `.env.local` (gitignored) — `ANTHROPIC_API_KEY`, `OPENCLAW_WORKSPACE_DIR`, optional `ALIGNFIRST_AGENT_SKILL_DIR`.
- `artifacts/` (gitignored) — per-run outputs.
- `.gateway-logs/` (gitignored) — `anthropic-payload.jsonl` (always), `raw-stream.jsonl` (opt-in).
