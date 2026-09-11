# AlignFirst Developer

Maintainer's map of AlignFirst Developer: the product and its current OpenClaw packaging. This
document is the entry point for working *on* the product in this repository. For creation and
deployment, use the
[`alignfirst-setup-guide`](../../skills/alignfirst-setup-guide/references/alignfirst-developer.md).

The [`@paleo/alignfirst-developer-openclaw-plugin`](../../packages/alignfirst-developer-openclaw-plugin/README.md) package supplies the product's OpenClaw capabilities. OpenClaw displays it as **AlignFirst Developer**, with plugin ID `alignfirst-developer`. Its root entry point registers feature modules; the first, `src/thread-handoff/`, owns the `thread_handoff` tool, delivery hook, recovery service and `openclaw thread-handoff` maintenance commands. Additional Developer capabilities can register through the same plugin.

## Three layers

1. **Reference workspace** —
   [`alignfirst-developer-tests/workspace/`](../../alignfirst-developer-tests/workspace/). The
   `myclaw` OpenClaw instance's bootstrap files (`AGENTS.md`, `IDENTITY.md`, `SOUL.md`, `USER.md`)
   load into the system prompt every turn. `AGENTS.md` sends every user message to the
   `alignfirst-developer-openclaw-playbook` dispatcher. The workspace carries no playbook copy.
2. **Operating-instructions playbook** — the
   [`alignfirst-developer-openclaw-playbook`](../../skills/alignfirst-developer-openclaw-playbook/)
   skill. `SKILL.md` routes thread sessions to `working-session.md` and channel/DM sessions to
   `channel-handling.md`. Its references own working sessions, channel handling, the `runbooks/`
   directory for project workspace setup and project lifecycle, and the `message` tool per surface.
   Project discovery comes from `alproject --guide`; the delegation procedure comes from
   `alcode --openclaw-guide` only when delegation starts.
3. **Regression-test harness** —
   [`alignfirst-developer-tests/`](../../alignfirst-developer-tests/). This standalone Dockerised
   consumer drives the workspace through synthetic Discord and Slack channels and judges the result.
   It bind-mounts the workspace, the playbook at `/home/claw/.openclaw/skills/alignfirst-developer-openclaw-playbook`, and the monorepo root into the gateway, so `alcode`, `alignfirst` and `alproject` run from the checkout. The managed skill path keeps the playbook out of the mock coding agent's context.
   The harness intercepts both supported delegated-agent subprocesses.

## How a turn flows

```text
user message
  → workspace AGENTS.md (auto-loaded)              layer 1
  → alignfirst-developer-openclaw-playbook/SKILL.md (read first)  layer 2  ← procedural dispatcher
  → references/working-session.md | channel-handling.md   layer 2
  → references/runbooks/project-lifecycle.md (create/onboard/remove)       layer 2
  → references/runbooks/project-workspace-setup.md (if the thread gets its workspace)  layer 2
  → run `alcode --openclaw-guide` (delegation manual, read last), then delegate via alcode
```

Layer 1 is the only thing OpenClaw injects automatically; everything in layer 2 is pulled in by an explicit file read because nested workspace files and skill files are not auto-loaded. The dispatch skill is read **first** and is purely procedural; the `alcode --openclaw-guide` output is read **last**, at delegation — keeping its protocol vocabulary out of the early user-facing acks (see [writing-instructions-for-openclaw.md](./writing-instructions-for-openclaw.md)). The guide also carries the completion procedure for backgrounded runs, so it sits in the delegating session's transcript when the completion turn arrives. How that turn is started is OpenClaw's business, not the plugin's; see [openclaw-plugin.md](./openclaw-plugin.md).

## The channel session only bootstraps a thread

A channel session answers ordinary conversation at the root. For project work, it runs `alproject list --json --root ~/projects`, resolves listed projects, records known project paths, ticket, one-line task, URLs, and the full text of a detailed request, then delivers one native thread starter. Discord uses anchored `thread-create`; Slack uses `send` with the triggering timestamp as `threadId`. After confirmed delivery, `thread_handoff start` durably records the handoff and dispatches `Take over this thread.` from `AlignFirst Service` as a reply run on the canonical thread session, with core delivering into the thread. The channel turn then ends. Resource URLs, multi-project requests, and requests that may need no project can leave values for the working session to resolve. Duplicate names and missing paths remain unresolved. The channel session never performs project work.

The fresh thread session routes by `topic_id`, calls `thread_handoff` with `{ "action": "claim" }`, and reads its own history before acting. The visible starter carries the request; the static service message only starts the turn. When the starter already asks for missing input, the takeover waits quietly until a human supplies it. An explicit hold remains in force. A final history read before coding catches human instructions that arrived during setup. Completion and later user turns stay on the same canonical thread session. Project creation and repository onboarding remain exceptions to the initial path requirement. The older manual-follow-up contract and, before it, channel-owned setup both produced avoidable routing failures; the historical artifact at `alignfirst-developer-tests/artifacts/2026-07-15T10-31-39-655Z/` documents the latter.

The heartbeat wake was retired after the 2026-09-10 incident: the heartbeat gate serialized every wake behind the agent's running turns and capped each turn at 600 seconds. The plugin's principles and the approaches tried before are in [`openclaw-plugin.md`](./openclaw-plugin.md). `HEARTBEAT_OK` remains the silence token for plugin reply runs as well as native heartbeat turns; it does not select their dispatch mechanism.

## Reading order for maintainers

- [`openclaw-plugin.md`](./openclaw-plugin.md) — what the plugin is for, the principles that bound it, and what was tried and dropped. Read this before changing how a thread starts.
- [`openclaw-context-engineering.md`](./openclaw-context-engineering.md) — what OpenClaw auto-loads, the surface/session/subagent model, Discord thread routing, debug env vars. Read this first before touching layer 1 or 2.
- [`writing-instructions-for-openclaw.md`](./writing-instructions-for-openclaw.md) — heuristics for authoring layer 1 / layer 2 files so they survive a hot model and the test suite.
- [`openclaw-test-architecture.md`](./openclaw-test-architecture.md) — the harness internals (topology, Dockerfiles, mocked CLIs, scenarios, artifacts, judge).
- [`alignfirst-developer-tests/README.md`](../../alignfirst-developer-tests/README.md) — running the suite, the `ABC-0<S>N` ticket convention, the gotchas.

## Running the suite

From [`alignfirst-developer-tests/`](../../alignfirst-developer-tests/):

```sh
cp .env.local.example .env.local   # fill ANTHROPIC_API_KEY
npm install
mkdir -p artifacts .gateway-logs   # create as your user so Docker doesn't make them root-owned
npm run env:build                  # only after image-affecting changes
npm run env:up
npm run e2e -- --model gpt-5.6-terra --channel discord-mock A01-new-work-to-be-done
npm run env:down
```

> ⚠️ **Never `rm -rf artifacts` (or `.gateway-logs`).** Runs are written to **timestamped** subdirs, so they accumulate without colliding — wiping the directory destroys prior runs for no reason. `mkdir -p` is enough to avoid root-owned dirs.

Run model matrices with Terra first. After they pass, use A11 on Slack for the smallest Sonnet compatibility check.

Scenario ids are the full filename stem (`A01-new-work-to-be-done`, not `A01`). Measure a flaky-looking assertion's true rate with `--iterations N --max-failures N` (raise `--max-failures` above its default of 1 so the matrix doesn't abort early). See [`writing-instructions-for-openclaw.md`](./writing-instructions-for-openclaw.md#doc-obedience-is-per-iteration).

## Deployment

The setup skill owns creation and deployment. Its
[`alignfirst-developer.md`](../../skills/alignfirst-setup-guide/references/alignfirst-developer.md)
reference assembles a version-controlled admin repository from a common base plus one channel
overlay, one coding-agent overlay and the optional dev-server gateway. The generated runbooks derive
configuration from the installed OpenClaw version, keep secrets outside git, and prepare managed
projects through the complete AlignFirst Developer contract.
