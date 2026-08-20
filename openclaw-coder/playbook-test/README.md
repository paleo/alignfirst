# playbook-test

Dockerised regression-test harness for the `myclaw` reference workspace at [`workspace/`](workspace/). Local-only. Manually run.

Standalone consumer of the `@paleo/openclaw-*` packages (own `package-lock.json`, not part of the root npm workspaces). See upstream docs for the generic mechanics:

- [packages/openclaw-test/README.md](../../packages/openclaw-test/README.md) — install, configure, run, scenario primitives, artifact layout.
- [docs/openclaw-coder/openclaw-test-architecture.md](../../docs/openclaw-coder/openclaw-test-architecture.md) — internals.

This README only documents what is specific to this harness.

## Install & run

```sh
cp .env.local.example .env.local
# Edit .env.local — fill ANTHROPIC_API_KEY and select ALIGNFIRST_CODE_AGENT

# Build the real alcode CLI the gateway runs (packages/alcode/dist must exist).
npm run build --workspace @paleo/alcode --prefix ../..

npm run vendor   # build + pack the local @paleo/openclaw-* into vendor/ (first run only; env:build repeats it)
npm install
npm run env:build
npm run env:up
npm run e2e -- --channel all --all
npm run env:down
```

See the upstream README for all flags. `--parallel K` (or `OPENCLAW_TEST_PARALLEL` in `.env.local`) runs cells concurrently on K worker stacks; per-worker workspace copies land in `.workers/` (gitignored). When upgrading from a pre-parallel version, tear down the legacy un-suffixed Compose project once: `docker compose down` from this dir.

> ⚠️ **Never `rm -rf artifacts` (or `.gateway-logs`).** Each run lands in its own **timestamped** subdir, so runs accumulate without colliding — deleting the directory throws away prior runs you may still need. These are bind-mount outputs; leave them in place.

## Configuration

- `OPENCLAW_WORKSPACE_DIR=./workspace` — the `myclaw` workspace, bind-mounted into the gateway. Workspace edits iterate live.
- `OPENCLAW_CODER_PLAYBOOK_SKILL_DIR` — host path to the `openclaw-coder-playbook` skill, bind-mounted into the gateway. Playbook edits iterate live, no rebuild.
- `ALIGNFIRST_CODE_DIR` — host path to `packages/alcode` (build it first). Live-mounted read-only at `/opt/alcode`; the `/usr/local/bin/alcode` wrapper runs `node /opt/alcode/bin/alcode.mjs`. Alcode runs for real, while both `claude` and `codex` resolve to the mock through PATH. Delegation instructions come from `alcode --openclaw-guide` (rendered from `templates/`, so guide edits iterate live).
- `ALIGNFIRST_CODE_AGENT=codex|claude` — required selector for alcode's child. It does not affect the OpenClaw conversation model. `ALIGNFIRST_CODE_MODELS` optionally narrows the agent models or pins a full Codex slug.
- [`docker-compose.yml`](docker-compose.yml) — `fixture-projects` named volume on gateway + runner at `/home/claw/projects`; the skill + alcode bind mounts on `gateway`; `OPENCLAW_TEST_JUDGE_MODEL=anthropic/claude-haiku-4-5` on `runner`.

## Fixtures

Each scenario starts fresh: [`scripts/reset-fixture.mjs`](scripts/reset-fixture.mjs) (run via `ctx.execInGateway(...)`) materializes two git repos on branch `main` at `/home/claw/projects/{nimbus,lumen}`, both copied from the committed [`projects-fixture/template/`](projects-fixture/template/) — a minimal Express monorepo stand-in. Each carries `package.json` `name` `@playbook-test/<name>-fixture`, `DEVELOPMENT.md` H1 `# Developing <Name>` and its own port block (`nimbus` from 6500, `lumen` from 6520), plus an (untracked) `.plans/` directory so `alcode`'s project gate is satisfied.

## Scenarios

Drop `scenarios/<id>.ts`, default-export `async (ctx: ScenarioContext) => void`. Shared helpers under `scenarios/_lib/` (skipped by the runner's discovery). Current scenarios: `A01`–`A13`.

Almost every one starts with `bootstrapThreadFromChannel` (`_lib/thread-bootstrap.ts`): it sends the channel message, waits for the starter, and asserts the channel session stopped right there — one thread post, no second one, no worktree on disk, no coding-agent call, nothing substantive leaked to the channel root. `sendInThread` then wakes the thread session, which owns the actual work. A scenario that seeds a worktree first passes its dir name as `seededWorktreeDirs` so the check still catches anything the channel session created.

`A10` exercises the real `alcode` foreground run driven as an OpenClaw background exec and rejects direct Claude or Codex launches. `A11` covers an explicit user hold. `A12` chains two delegations in one thread, exposing the heartbeat-cooldown wake gate. `A13` drives alcode directly for deterministic selected-agent new/resume coverage and Codex failure handling. The shared mock serves a bundled Codex model catalog and both agents' JSONL protocols.

Rebuild the alcode package and harness image before focused coverage:

```sh
npm run build --workspace @paleo/alcode --prefix ../..
npm run env:build

ALIGNFIRST_CODE_AGENT=codex npm run e2e -- --channel discord-mock A13-alcode-agent-contract
ALIGNFIRST_CODE_AGENT=codex npm run e2e -- --channel all A10-coding-session A12-sequential-coding-sessions
ALIGNFIRST_CODE_AGENT=claude npm run e2e -- --channel all A13-alcode-agent-contract A10-coding-session
```

**Ticket-id convention:** scenario `A<S>` uses `ABC-0<S>N` (`A1` → `ABC-010`, `A2` → `ABC-020`, …; `A10` → `ABC-0100`). The mechanical mapping is a leak signal: while running `A<S>`, any `ABC-0<X>N` with `X ≠ S` is bleed from another scenario. The test sender is `ROBIN01` (a `tech` user in [`workspace/USER.md`](workspace/USER.md)). A5's `aurora` is deliberately **not** a fixture name (unknown-project path).

## Vendored `@paleo/openclaw-*` packages

This harness always tests the **local** `@paleo/openclaw-*` sources, never npmjs — the four packages iterate in lockstep with the mocks and are frequently ahead of a publish. The dependencies are `file:vendor/<pkg>.tgz`; [`scripts/vendor-packages.mjs`](scripts/vendor-packages.mjs) (`npm run vendor`) builds each package and `npm pack`s it into `vendor/` (gitignored). The Docker build context is this dir, so the tarballs must live here — `../../packages/*` is out of reach at build time.

`npm run env:build` chains `vendor` → `npm install` (refreshes `package-lock.json` against the new tarballs) → `openclaw-test env build`, so a source edit in any of the four packages is picked up on the next `env:build` with no manual step. `npm pack` is byte-reproducible, so unchanged sources produce no lockfile churn. Run `npm run vendor` by hand before the first `npm install` (the tarballs must exist for it to resolve).

## Layout

- [`openclaw.json`](openclaw.json) · [`docker-compose.yml`](docker-compose.yml) · [`Dockerfile`](Dockerfile) · [`package.json`](package.json) · [`scripts/vendor-packages.mjs`](scripts/vendor-packages.mjs) — committed.
- `vendor/` (gitignored) — locally-built `@paleo/openclaw-*` tarballs, regenerated by `npm run vendor`.
- `.env.local` (gitignored) — API keys, workspace/skill/alcode paths, and `ALIGNFIRST_CODE_AGENT`.
- `artifacts/` (gitignored) — per-run outputs.
- `.gateway-logs/` (gitignored) — `trajectory/<sessionId>.jsonl` (always, provider-neutral), `raw-stream.jsonl` (opt-in).
