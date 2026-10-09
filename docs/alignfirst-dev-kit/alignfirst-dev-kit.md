# AlignFirst Dev Kit for OpenClaw

Maintainer's map of the AlignFirst Dev Kit: the product and its current OpenClaw packaging. This
document is the entry point for working *on* the product in this repository. For creation and
deployment, use the
[`alignfirst-setup-guide`](../../skills/alignfirst-setup-guide/references/alignfirst-dev-kit.md).

The [`@alignfirst/service-openclaw-plugin`](../../packages/service-openclaw-plugin/README.md) package supplies the product's OpenClaw capabilities. OpenClaw displays it as **AlignFirst Service**, with plugin ID `alignfirst-service`. Its root entry point registers feature modules; the first, `src/thread-handoff/`, owns the `thread_handoff` tool, delivery hook, recovery service and `openclaw thread-handoff` maintenance commands. Additional assistant capabilities can register through the same plugin.

## Three layers

1. **Reference workspace** —
   [`alignfirst-dev-kit-tests/workspace/`](../../alignfirst-dev-kit-tests/workspace/). The
   `myassistant` OpenClaw instance's bootstrap files (`AGENTS.md`, `IDENTITY.md`, `SOUL.md`, `USER.md`)
   load into the system prompt every turn. `AGENTS.md` makes `aligndev guide` the first action on
   every activation. The workspace carries no playbook copy.
2. **Operating-instructions playbook** — the `aligndev guide` topics, rendered from
   [`packages/aligndev/templates/guide/playbook/`](../../packages/aligndev/templates/guide/playbook/).
   The dispatcher (`aligndev guide`) routes thread sessions to `aligndev guide working-session` and
   channel/DM sessions to `aligndev guide channel-handling`. The other topics own the runbooks for
   project workspace setup, project lifecycle and consultations, and the `message` tool per
   surface.
   Project discovery comes from `aligndev guide project`; the delegation procedure comes from
   `aligndev guide code` only when delegation starts.
3. **Regression-test harness** —
   [`alignfirst-dev-kit-tests/`](../../alignfirst-dev-kit-tests/). This standalone Dockerised
   consumer drives the workspace through synthetic Discord and Slack channels and judges the result.
   It bind-mounts the workspace and the monorepo root into the gateway, so `aligndev` and `alignfirst` run from the checkout and `aligndev guide` prints the checkout's playbook.
   The harness intercepts both supported delegated-agent subprocesses.

## How a turn flows

```text
user message
  → workspace AGENTS.md (auto-loaded)                                       layer 1
  → aligndev guide (read first)                                                layer 2  ← procedural dispatcher
  → aligndev guide working-session | channel-handling                          layer 2
  → aligndev guide project-lifecycle (create/onboard/remove)                   layer 2
  → aligndev guide consultation (question, advice, brainstorming)              layer 2
  → aligndev guide project-workspace-setup (if the thread gets its workspace)  layer 2
  → aligndev guide code (delegation manual, read last), then delegate via aligndev code
```

Layer 1 is the only thing OpenClaw injects automatically; everything in layer 2 is pulled in by explicit `aligndev guide` commands run through `exec`. The dispatcher is read **first** and is purely procedural; the `aligndev guide code` output is read **last**, at delegation — keeping its protocol vocabulary out of the early user-facing acks (see [writing-instructions-for-openclaw.md](./writing-instructions-for-openclaw.md)). The guide also carries the completion procedure for backgrounded runs, so it sits in the delegating session's transcript when the completion turn arrives. How that turn is started is OpenClaw's business, not the plugin's; see [openclaw-plugin.md](./openclaw-plugin.md).

## The channel session only bootstraps a thread

A channel session answers ordinary conversation at the root. For project work, it runs `aligndev project list --json`, resolves listed projects, records known project paths, ticket, one-line task, URLs, and the full text of a detailed request, then delivers one native thread starter. Discord opens the thread with an anchored `thread-create` and posts the starter with `thread-reply`; Slack uses `send` with the triggering timestamp as `threadId`. After confirmed delivery, `thread_handoff start` durably records the handoff and dispatches `Take over this thread.` from `AlignFirst Service` as a reply run on the canonical thread session, with core delivering into the thread. The channel turn then ends on `NO_REPLY`: the starter is its reply. Resource URLs, multi-project requests, and requests that may need no project can leave values for the working session to resolve. Duplicate names and missing paths remain unresolved. The channel session never performs project work.

Every fresh thread session routes by `topic_id`, calls `thread_handoff` with `{ "action": "claim" }`, and reads its own history before acting. It reacts with 🦞 to the newest visible message from that completed history snapshot before setup or another visible action. This applies to new threads, human-created threads, and fresh sessions taking over existing threads. The static service message only starts a takeover turn. It is internal to OpenClaw, absent from the surface history and therefore cannot be the reaction target. The visible starter carries the request. When the starter already asks for missing input, the takeover waits quietly until a human supplies it. An explicit hold remains in force. A final history read before coding catches human instructions that arrived during setup. Completion and later user turns stay on the same canonical thread session. Project creation and repository onboarding remain exceptions to the initial path requirement. The older manual-follow-up contract and, before it, channel-owned setup both produced avoidable routing failures; the historical artifact at `alignfirst-dev-kit-tests/artifacts/2026-07-15T10-31-39-655Z/` documents the latter.

The heartbeat wake was retired after the 2026-09-10 incident: the heartbeat gate serialized every wake behind the assistant's running turns and capped each turn at 600 seconds. The plugin's principles and the approaches tried before are in [`openclaw-plugin.md`](./openclaw-plugin.md). `HEARTBEAT_OK` remains the silence token for plugin reply runs as well as native heartbeat turns; it does not select their dispatch mechanism.

## Companion-backed projects

A managed project can keep its AlignFirst files in a companion directory, outside its repository. The seed creates the service-owned `~/.alignfirst/companions/` inside the locked `~/.alignfirst/`. The assistant registers a project in the companion registry there with `alignfirst companion add`, and unregisters it with `alignfirst companion unregister` before removing the project. The playbook reads each file's location from `aligndev project status`. A project whose `DEVELOPERS.md` is missing or has no workspaces section runs in main-worktree mode: its main worktree is its only workspace, claimed by one working thread at a time. See [companion-directories.md](../companion-directories.md).

## A coding agent as the assistant

The same templates serve a second platform, `codingAgent`: a Claude Code or Codex session acting as the assistant on one project, the repository where it started. `aligndev guide` selects the platform from `platform` in the `aligndev` config, and each template keeps platform-specific paragraphs in `{{#openclaw}}` and `{{#codingAgent}}` blocks. The `codingAgent` playbook has no surface, thread or project inventory; the `aligndev` skill starts it. [Shared templates](./writing-instructions-for-openclaw.md#shared-templates) gives the authoring rules, and the setup guide's [`coding-agent-assistant.md`](../../skills/alignfirst-setup-guide/references/coding-agent-assistant.md) the installation.

## Reading order for maintainers

- [`openclaw-plugin.md`](./openclaw-plugin.md) — what the plugin is for, the principles that bound it, and what was tried and dropped. Read this before changing how a thread starts.
- [`openclaw-context-engineering.md`](./openclaw-context-engineering.md) — what OpenClaw auto-loads, the surface/session/subagent model, Discord thread routing, debug env vars. Read this first before touching layer 1 or 2.
- [`writing-instructions-for-openclaw.md`](./writing-instructions-for-openclaw.md) — heuristics for authoring layer 1 / layer 2 files so they survive a hot model and the test suite.
- [`running-openclaw-tests.md`](./running-openclaw-tests.md) — setup, credentials, scenario selection, fixtures, artifacts, and maintenance notes.
- [`openclaw-test-architecture.md`](./openclaw-test-architecture.md) — the harness internals (topology, Dockerfiles, mocked CLIs, scenarios, artifacts, judge).

## Running the suite

[Running the OpenClaw Tests](./running-openclaw-tests.md) is the operator guide for the Dev Kit harness. It covers setup, safe artifact handling, focused checks, full matrices, and the ticket-id convention.

## Deployment

The setup skill owns creation and deployment. Its
[`alignfirst-dev-kit.md`](../../skills/alignfirst-setup-guide/references/alignfirst-dev-kit.md)
reference assembles a version-controlled admin repository from a common base plus one channel
overlay, one coding-agent overlay and the optional dev-server gateway. The generated runbooks derive
configuration from the installed OpenClaw version, keep secrets outside git, and prepare managed
projects through the complete Dev Kit contract.
