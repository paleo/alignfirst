# OpenClaw Coder

Maintainer's map of the [`openclaw-coder/`](../openclaw-coder/) subproject: a neutral, shareable packaging of OpenClaw as an autonomous AI programmer. This doc is the entry point for working *on* the subproject in this repo. For using it, see its own [`README.md`](../openclaw-coder/README.md).

## Three layers

1. **Reference workspace** — [`openclaw-coder/workspace/`](../openclaw-coder/workspace/). The `myclaw` OpenClaw instance's bootstrap files (`AGENTS.md`, `IDENTITY.md`, `SOUL.md`, `USER.md`, `TOOLS.md`). These are auto-loaded into the system prompt every turn. `AGENTS.md` is a thin pointer: on every user message it sends the agent into the `openclaw-coder-playbook` skill's dispatcher. The workspace carries **no** playbook copy — the skill is the single source.
2. **Operating-instructions playbook** — the [`openclaw-coder-playbook`](../skills/openclaw-coder-playbook/) skill. Its `SKILL.md` is the dispatcher: it routes by surface (thread → `working-session.md`; channel/DM → `channel-handling.md`) and carries the global rules (language, "tickets are labels", projects, `chat_id`). The procedures live in [`references/`](../skills/openclaw-coder-playbook/references/) (`working-session.md`, `channel-handling.md`, `project-workspace-setup.md`). Coding is delegated to the separate `alignfirst-coaching` coaching skill. Nothing here is auto-loaded — files are read on demand (see context engineering below).
3. **Regression-test harness** — [`openclaw-coder/playbook-test/`](../openclaw-coder/playbook-test/). A standalone Dockerised consumer of the published `@paleo/openclaw-*` packages that drives the workspace through synthetic Discord/Slack channels and judges the outcome. It bind-mounts both the workspace dir and the `alignfirst-coaching` skill into the gateway, so edits to layers 1 and 2 iterate live without rebuilding the image.

## How a turn flows

```text
user message
  → workspace AGENTS.md (auto-loaded)              layer 1
  → openclaw-coder-playbook/SKILL.md (read first)  layer 2  ← procedural dispatcher
  → references/working-session.md | channel-handling.md   layer 2
  → references/project-workspace-setup.md (if WORK)       layer 2
  → delegate coding to the alignfirst-coaching skill (coaching/CLI, read last)
```

Layer 1 is the only thing OpenClaw injects automatically; everything in layer 2 is pulled in by an explicit file read because nested workspace files and skill files are not auto-loaded. The dispatch skill is read **first** and is purely procedural; the coaching `alignfirst-coaching/SKILL.md` is read **last**, at delegation — keeping its protocol vocabulary out of the early user-facing acks (see [writing-workspace-files.md](./writing-workspace-files.md)).

## Reading order for maintainers

- [`openclaw-context-engineering.md`](./openclaw-context-engineering.md) — what OpenClaw auto-loads, the surface/session/subagent model, Discord thread routing, debug env vars. Read this first before touching layer 1 or 2.
- [`writing-workspace-files.md`](./writing-workspace-files.md) — heuristics for authoring layer 1 / layer 2 files so they survive a hot model and the test suite.
- [`openclaw-test-architecture.md`](./openclaw-test-architecture.md) — the harness internals (topology, Dockerfiles, mocked CLIs, scenarios, artifacts, judge).
- [`openclaw-coder/playbook-test/README.md`](../openclaw-coder/playbook-test/README.md) — running the suite, the `ABC-0<S>N` ticket convention, the gotchas.

## Running the suite

From [`openclaw-coder/playbook-test/`](../openclaw-coder/playbook-test/):

```sh
cp .env.local.example .env.local   # fill ANTHROPIC_API_KEY
npm install
rm -rf artifacts .gateway-logs && mkdir -p artifacts .gateway-logs   # avoid root-owned bind-mount dirs
npm run env:build                  # only after image-affecting changes
npm run env:up
npm run e2e -- --channel discord-mock A1-new-work-to-be-done
npm run env:down
```

Scenario ids are the full filename stem (`A1-new-work-to-be-done`, not `A1`). Measure a flaky-looking assertion's true rate with `--iterations N --max-failures N` (raise `--max-failures` above its default of 1 so the matrix doesn't abort early). See [`writing-workspace-files.md`](./writing-workspace-files.md#doc-obedience-is-per-iteration).

## Deployment

Running `myclaw` against real Discord/Slack workspaces (not the mock channels) needs provider-side bot setup — see [`openclaw-coder/bot-setup.md`](../openclaw-coder/bot-setup.md).
