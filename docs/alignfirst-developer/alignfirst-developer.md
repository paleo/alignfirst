# AlignFirst Developer

Maintainer's map of AlignFirst Developer: the product and its current OpenClaw packaging. This
document is the entry point for working *on* the product in this repository. For creation and
deployment, use the
[`alignfirst-setup-guide`](../../skills/alignfirst-setup-guide/references/alignfirst-developer.md).

## Three layers

1. **Reference workspace** —
   [`alignfirst-developer-tests/workspace/`](../../alignfirst-developer-tests/workspace/). The
   `myclaw` OpenClaw instance's bootstrap files (`AGENTS.md`, `IDENTITY.md`, `SOUL.md`, `USER.md`)
   load into the system prompt every turn. `TOOLS.md` stays empty; its content lives in `AGENTS.md`
   under `## Environment`. `AGENTS.md` sends every user message to the
   `alignfirst-developer-openclaw-playbook` dispatcher. The workspace carries no playbook copy.
2. **Operating-instructions playbook** — the
   [`alignfirst-developer-openclaw-playbook`](../../skills/alignfirst-developer-openclaw-playbook/)
   skill. `SKILL.md` routes thread sessions to `working-session.md` and channel/DM sessions to
   `channel-handling.md`. Its references own working sessions, channel handling, project workspace
   setup, project lifecycle, and the `message` tool per surface. Project discovery comes from `alproject --guide`; the delegation
   procedure comes from `alcode --openclaw-guide` only when delegation starts.
3. **Regression-test harness** —
   [`alignfirst-developer-tests/`](../../alignfirst-developer-tests/). This standalone Dockerised
   consumer drives the workspace through synthetic Discord and Slack channels and judges the result.
   It bind-mounts the workspace, playbook skill, and built `@paleo/alcode` package into the gateway.
   The harness intercepts both supported delegated-agent subprocesses.

## How a turn flows

```text
user message
  → workspace AGENTS.md (auto-loaded)              layer 1
  → alignfirst-developer-openclaw-playbook/SKILL.md (read first)  layer 2  ← procedural dispatcher
  → references/working-session.md | channel-handling.md   layer 2
  → references/project-lifecycle.md (create/remove)       layer 2
  → references/project-workspace-setup.md (if the thread gets its workspace)  layer 2
  → run `alcode --openclaw-guide` (delegation manual, read last), then delegate via alcode
```

Layer 1 is the only thing OpenClaw injects automatically; everything in layer 2 is pulled in by an explicit file read because nested workspace files and skill files are not auto-loaded. The dispatch skill is read **first** and is purely procedural; the `alcode --openclaw-guide` output is read **last**, at delegation — keeping its protocol vocabulary out of the early user-facing acks (see [writing-instructions-for-openclaw.md](./writing-instructions-for-openclaw.md)). The guide also carries the completion procedure for backgrounded runs, so it sits in the delegating session's transcript when the completion wake arrives — the guide's own chained `openclaw system event` command, not OpenClaw's native exec-exit notify, which the heartbeat cooldown gates (see `.plans/32/B1-upstream-issue.md`).

## The channel session only bootstraps a thread

A channel/DM session runs `alproject list --json` before routing a message that may refer to a project. It resolves filesystem-present projects only, then records the known project paths, ticket, one-line task, and the full text of a detailed request. It opens a thread and ends the turn. Resource URLs, multi-project requests, and requests that may need no project can leave values for the working session to resolve. Duplicate names and missing project paths stay unresolved until the user selects a usable canonical path. The channel session never sets up a workspace, delegates to `alcode`, inspects a codebase, or reports a status — the thread session does all of that, whatever the user asked for and however explicit their green light was.

The cost is one round-trip: a thread session activates on the user's next message in that thread, so the starter ends by bringing the user back. It asks only for a value the channel can establish is required; otherwise it states that the next message launches the working session. Project creation is the exception to the path requirement: the lifecycle procedure establishes the new canonical path. The gain is that everything substantive runs in a session whose plain text auto-streams to the right surface. The previous contract had the channel session finish the setup in-turn, which forced every post through `message`+`threadId` and made a leak to the channel root the standard failure (`alignfirst-developer-tests/artifacts/2026-07-15T10-31-39-655Z/`).

## Reading order for maintainers

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
npm run e2e -- --channel discord-mock A1-new-work-to-be-done
npm run env:down
```

> ⚠️ **Never `rm -rf artifacts` (or `.gateway-logs`).** Runs are written to **timestamped** subdirs, so they accumulate without colliding — wiping the directory destroys prior runs for no reason. `mkdir -p` is enough to avoid root-owned dirs.

Scenario ids are the full filename stem (`A1-new-work-to-be-done`, not `A1`). Measure a flaky-looking assertion's true rate with `--iterations N --max-failures N` (raise `--max-failures` above its default of 1 so the matrix doesn't abort early). See [`writing-instructions-for-openclaw.md`](./writing-instructions-for-openclaw.md#doc-obedience-is-per-iteration).

## Deployment

The setup skill owns creation and deployment. Its
[`alignfirst-developer.md`](../../skills/alignfirst-setup-guide/references/alignfirst-developer.md)
reference assembles a version-controlled admin repository from a common base plus one channel
overlay, one coding-agent overlay and the optional dev-server gateway. The generated runbooks derive
configuration from the installed OpenClaw version, keep secrets outside git, and prepare managed
projects through the complete AlignFirst Developer contract.
