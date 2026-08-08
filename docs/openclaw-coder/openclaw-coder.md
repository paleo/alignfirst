# OpenClaw Coder

Maintainer's map of the [`openclaw-coder/`](../openclaw-coder/) subproject: a shareable packaging of OpenClaw as an autonomous AI programmer. This doc is the entry point for working *on* the subproject in this repo. For using it, see its own [`README.md`](../openclaw-coder/README.md).

## Three layers

1. **Reference workspace** — [`openclaw-coder/playbook-test/workspace/`](../openclaw-coder/playbook-test/workspace/). The `myclaw` OpenClaw instance's bootstrap files (`AGENTS.md`, `IDENTITY.md`, `SOUL.md`, `USER.md`, `TOOLS.md`), auto-loaded into the system prompt every turn. It lives inside the harness (its only consumer) as the test fixture, and doubles as the worked example the consumer [`README`](../openclaw-coder/README.md) points at. `AGENTS.md` is a thin pointer: on every user message it sends the agent into the `openclaw-coder-playbook` skill's dispatcher. The workspace carries **no** playbook copy — the skill is the single source.
2. **Operating-instructions playbook** — the [`openclaw-coder-playbook`](../skills/openclaw-coder-playbook/) skill. Its `SKILL.md` is the dispatcher: it routes by surface (thread → `working-session.md`; channel/DM → `channel-handling.md`) and carries the global rules ("tickets are labels", projects, `chat_id`, and the channel/thread split below); the language rule lives in the workspace `AGENTS.md`. The procedures live in [`references/`](../skills/openclaw-coder-playbook/references/) (`working-session.md`, `channel-handling.md`, `project-workspace-setup.md`). Coding is delegated to the `alcode` CLI; the delegation manual is its `--openclaw-guide` output ([`packages/alcode/templates/openclaw-guide.md`](../packages/alcode/templates/openclaw-guide.md)), run via `exec` at delegation time. Nothing here is auto-loaded — files are read on demand (see context engineering below).
3. **Regression-test harness** — [`openclaw-coder/playbook-test/`](../openclaw-coder/playbook-test/). A standalone Dockerised consumer of the published `@paleo/openclaw-*` packages that drives the workspace through synthetic Discord/Slack channels and judges the outcome. It bind-mounts the workspace dir, the playbook skill, and the built `@paleo/alcode` package into the gateway, so edits to layers 1 and 2 (and the guide) iterate live without rebuilding the image.

## How a turn flows

```text
user message
  → workspace AGENTS.md (auto-loaded)              layer 1
  → openclaw-coder-playbook/SKILL.md (read first)  layer 2  ← procedural dispatcher
  → references/working-session.md | channel-handling.md   layer 2
  → references/project-workspace-setup.md (if the thread gets its workspace)  layer 2
  → run `alcode --openclaw-guide` (delegation manual, read last), then delegate via alcode
```

Layer 1 is the only thing OpenClaw injects automatically; everything in layer 2 is pulled in by an explicit file read because nested workspace files and skill files are not auto-loaded. The dispatch skill is read **first** and is purely procedural; the `alcode --openclaw-guide` output is read **last**, at delegation — keeping its protocol vocabulary out of the early user-facing acks (see [writing-instructions-for-openclaw.md](./writing-instructions-for-openclaw.md)). The guide also carries the completion procedure for backgrounded runs, so it sits in the delegating session's transcript when the completion wake arrives — the guide's own chained `openclaw system event` command, not OpenClaw's native exec-exit notify, which the heartbeat cooldown gates (see `.plans/32/B1-upstream-issue.md`).

## The channel session only bootstraps a thread

A channel/DM session collects the handoff values (project, ticket, audience, a one-line task), opens a thread carrying them in its starter, and ends the turn. It never sets up a workspace, delegates to `alcode`, inspects a codebase, or reports a status — the thread session does all of that, whatever the user asked for and however explicit their green light was.

The cost is one round-trip: a thread session activates on the user's next message in that thread, so the starter ends by bringing the user back — a question for a missing value when there is one (ticket, project, scope), otherwise the plain statement that the next message launches the thread session. The gain is that everything substantive runs in a session whose plain text auto-streams to the right surface. The previous contract had the channel session finish the setup in-turn, which forced every post through `message`+`threadId` and made a leak to the channel root the standard failure (`playbook-test/artifacts/2026-07-15T10-31-39-655Z/`).

## Reading order for maintainers

- [`openclaw-context-engineering.md`](./openclaw-context-engineering.md) — what OpenClaw auto-loads, the surface/session/subagent model, Discord thread routing, debug env vars. Read this first before touching layer 1 or 2.
- [`writing-instructions-for-openclaw.md`](./writing-instructions-for-openclaw.md) — heuristics for authoring layer 1 / layer 2 files so they survive a hot model and the test suite.
- [`openclaw-test-architecture.md`](./openclaw-test-architecture.md) — the harness internals (topology, Dockerfiles, mocked CLIs, scenarios, artifacts, judge).
- [`openclaw-coder/playbook-test/README.md`](../openclaw-coder/playbook-test/README.md) — running the suite, the `ABC-0<S>N` ticket convention, the gotchas.

## Running the suite

From [`openclaw-coder/playbook-test/`](../openclaw-coder/playbook-test/):

```sh
cp .env.local.example .env.local   # fill ANTHROPIC_API_KEY
npm install
mkdir -p artifacts .gateway-logs   # create as your user so Docker doesn't make them root-owned
npm run env:build                  # only after image-affecting changes
npm run env:up
npm run e2e -- --channel discord-mock A1-new-work-to-be-done
npm run env:down
```

> ⚠️ **Never `rm -rf artifacts` (or `.gateway-logs`).** Runs are written to **timestamped** subdirs, so they accumulate without colliding — wiping the directory destroys prior runs for no reason. `mkdir -p` is enough to avoid root-owned dirs.

Scenario ids are the full filename stem (`A1-new-work-to-be-done`, not `A1`). Measure a flaky-looking assertion's true rate with `--iterations N --max-failures N` (raise `--max-failures` above its default of 1 so the matrix doesn't abort early). See [`writing-instructions-for-openclaw.md`](./writing-instructions-for-openclaw.md#doc-obedience-is-per-iteration).

## Deployment

Running a coder against real Discord/Slack (not the mock channels) is documented for consumers in [`openclaw-coder/README.md`](../openclaw-coder/README.md) — the `openclaw.json` knobs and the `AGENTS.md` template. Creating the bot itself (tokens, scopes, Socket Mode) is standard OpenClaw; defer to OpenClaw's channel docs.
