# AlignDev for OpenClaw

Maintainer's map of AlignDev for OpenClaw: the product and its OpenClaw packaging. This
document is the entry point for working *on* the product in this repository. For creation and
deployment, use the
[`alignfirst-setup-guide`](../../skills/alignfirst-setup-guide/references/aligndev-openclaw.md).

The [`@alignfirst/service-openclaw-plugin`](../../packages/service-openclaw-plugin/README.md) package supplies the product's OpenClaw capabilities. OpenClaw displays it as **AlignFirst Service**, with plugin ID `alignfirst-service`. Its root entry point registers feature modules; the first, `src/thread-handoff/`, owns the `thread_handoff` tool, delivery hook, recovery service and `openclaw thread-handoff` maintenance commands. Additional assistant capabilities can register through the same plugin.

## Three layers

1. **Reference workspace** —
   [`aligndev-openclaw-tests/workspace/`](../../aligndev-openclaw-tests/workspace/). The
   `myassistant` OpenClaw instance's bootstrap files (`AGENTS.md`, `IDENTITY.md`, `SOUL.md`, `USER.md`)
   load into the system prompt every turn. `AGENTS.md` makes `aligndev guide` the first action on
   every activation. The workspace carries no playbook copy.
2. **Operating-instructions playbook** — the `aligndev guide` topics, rendered from
   [`packages/aligndev/templates/guide/playbook/`](../../packages/aligndev/templates/guide/playbook/)
   for three contexts: a Slack thread, a Discord thread and an app conversation. The dispatcher
   (`aligndev guide`) routes an app conversation to `aligndev guide --channel app working-session`,
   a thread session to `aligndev guide --channel <surface> working-session` and a channel/DM
   session to `aligndev guide --channel <surface> channel-handling`; each prints the surface's
   playbook first. The other topics own the runbooks for project workspace setup, project
   lifecycle and consultations, and the `message` tool per thread surface.
   Project discovery comes from `aligndev guide project`; the delegation procedure comes from
   `aligndev guide --channel <surface> code` only when delegation starts.
3. **Regression-test harness** —
   [`aligndev-openclaw-tests/`](../../aligndev-openclaw-tests/). This standalone Dockerised
   consumer drives the workspace through synthetic Discord and Slack channels and the gateway's app surface, `webchat`, and judges the result.
   It bind-mounts the workspace and the monorepo root into the gateway, so `aligndev` and `alignfirst` run from the checkout and `aligndev guide` prints the checkout's playbook.
   The harness intercepts Claude Code, Codex and Pi delegated-agent subprocesses through a generated named profile. Its offline helper tests cover mock contracts; scenario and live deployment acceptance remain separate.

## How a turn flows

```text
user message
  → workspace AGENTS.md (auto-loaded)                                       layer 1
  → aligndev guide (read first)                                    layer 2  ← procedural dispatcher
  → aligndev guide --channel app working-session (app conversation),
    or aligndev guide --channel <slack|discord> working-session | channel-handling
                     (the surface's playbook, then the topic)      layer 2
  → … project-lifecycle (create/onboard/remove)                    layer 2
  → … consultation (question, advice, brainstorming)               layer 2
  → … project-workspace-setup (when the work needs a workspace)    layer 2
  → … code (delegation manual, read last), then delegate via aligndev code
```

Layer 1 is the only thing OpenClaw injects automatically; everything in layer 2 is pulled in by explicit `aligndev guide` commands run through `exec`. The dispatcher routes on the turn metadata: `channel: "webchat"` for an app conversation, `topic_id` for a thread. The dispatcher is read **first** and is purely procedural; the `aligndev guide code` output is read **last**, at delegation — keeping its protocol vocabulary out of the early user-facing acks (see [writing-instructions-for-openclaw.md](./writing-instructions-for-openclaw.md)). The guide also carries the completion procedure for backgrounded runs, so it sits in the delegating session's transcript when the completion turn arrives. How that turn is started is OpenClaw's business, not the plugin's; see [openclaw-plugin.md](./openclaw-plugin.md).

## The channel session only bootstraps a thread

A channel session answers ordinary conversation at the root. For project work, it runs `aligndev project list --json`, resolves listed projects, records known project paths, ticket, one-line task, URLs, and the full text of a detailed request, then delivers one native thread starter. Discord opens the thread with an anchored `thread-create` and posts the starter with `thread-reply`; Slack uses `send` with the triggering timestamp as `threadId`. After confirmed delivery, `thread_handoff start` durably records the handoff and dispatches `Take over this thread.` from `AlignFirst Service` as a reply run on the canonical thread session, with core delivering into the thread. The channel turn then ends on `NO_REPLY`: the starter is its reply. Resource URLs, multi-project requests, and requests that may need no project can leave values for the working session to resolve. Duplicate names and missing paths remain unresolved. The channel session never performs project work.

Every fresh thread session routes by `topic_id`, calls `thread_handoff` with `{ "action": "claim" }`, and reads its own history before acting. It reacts with 🦞 to the newest visible message from that completed history snapshot before setup or another visible action. This applies to new threads, human-created threads, and fresh sessions taking over existing threads. The static service message only starts a takeover turn. It is internal to OpenClaw, absent from the surface history and therefore cannot be the reaction target. The visible starter carries the request. When the starter already asks for missing input, the takeover waits quietly until a human supplies it. An explicit hold remains in force. A final history read before coding catches human instructions that arrived during setup. Completion and later user turns stay on the same canonical thread session. Project creation and repository onboarding remain exceptions to the initial path requirement. The older manual-follow-up contract and, before it, channel-owned setup both produced avoidable routing failures; the historical artifact at `aligndev-openclaw-tests/artifacts/2026-07-15T10-31-39-655Z/` documents the latter.

The heartbeat wake was retired after the 2026-09-10 incident: the heartbeat gate serialized every wake behind the assistant's running turns and capped each turn at 600 seconds. The plugin's principles and the approaches tried before are in [`openclaw-plugin.md`](./openclaw-plugin.md). `HEARTBEAT_OK` remains the silence token for plugin reply runs as well as native heartbeat turns; it does not select their dispatch mechanism.

## App conversations

The Control UI, the desktop apps and the mobile apps are clients of one gateway surface, `webchat`. The user creates each conversation, so no plugin is involved: no starter, no handoff, no `message` tool. An app conversation is a working session that follows the `codingAgent` conversation model on OpenClaw's machinery; the templates share that text through `{{#conversation}}` blocks.

- **Home** (`agent:<agentId>:main`) is for chat. An actionable message there gets one reply asking for a new conversation, and no project work.
- **A conversation on the agent workspace** resolves its project from the request and the inventory, then opens or creates the ticket's workspace.
- **A conversation on a project folder** runs in the main worktree: the project comes from its working directory, and the work goes to the ticket's workspace.
- **A conversation with a managed worktree** runs in a fresh checkout on `openclaw/<name>`. The setup runbook adopts it in place: it switches the checkout to the ticket branch and registers it through `alignfirst workspace setup`. Adoption preserves external deletion ownership; run teardown before OpenClaw archives/deletes it, unless the user explicitly transfers that ownership.

The working session identifies the conversation with `session_status`, whose key also addresses the completion wake. The report of a background run returns to the same conversation. [`openclaw-context-engineering.md`](./openclaw-context-engineering.md#webchat-surface) records the gateway facts behind these rules.

## Companion-backed projects

A managed project can keep its AlignFirst files in a companion directory, outside its repository. The seed creates the service-owned `~/.alignfirst/companions/` inside the locked `~/.alignfirst/`. The assistant registers a project in the companion registry there with `alignfirst companion register`, and unregisters it with `alignfirst companion unregister` before removing the project. The playbook reads each file's location from `aligndev project status`. Both platforms directly prepare through `alignfirst workspace`, using the selected merged configuration's recipe or protocol-ready defaults. Companions may supply the complete recipe and external runtime; local placement alone requires ignored checkout runtime storage. Companion plans resolve directly from each worktree without a link. The authorized `work-files-setup` guide topic runs before ticket or session effects when effective plans are missing or project-tracked, leaving old project content untouched without copying it. See [companion-directories.md](../companion-directories.md).

## A coding agent as the assistant

The same templates serve a second platform, `codingAgent`: a Claude Code, Codex or persistent Pi session acting as the assistant on one project, the repository where it started. `aligndev guide` selects the platform from `platform` in the aligndev settings, and each template keeps context-specific paragraphs in fact blocks such as `{{#openclaw}}`, `{{#thread}}`, `{{#conversation}}` and `{{#codingAgent}}`. The `codingAgent` playbook has no surface, thread or project inventory; the `aligndev` skill starts it. [Shared templates](./writing-instructions-for-openclaw.md#shared-templates) gives the authoring rules, and the setup guide's [`coding-agent-assistant.md`](../../skills/alignfirst-setup-guide/references/coding-agent-assistant.md) the installation.

## Reading order for maintainers

- [`openclaw-plugin.md`](./openclaw-plugin.md) — what the plugin is for, the principles that bound it, and what was tried and dropped. Read this before changing how a thread starts.
- [`openclaw-context-engineering.md`](./openclaw-context-engineering.md) — what OpenClaw auto-loads, the surface/session/subagent model, Discord thread routing, debug env vars. Read this first before touching layer 1 or 2.
- [`writing-instructions-for-openclaw.md`](./writing-instructions-for-openclaw.md) — heuristics for authoring layer 1 / layer 2 files so they survive a hot model and the test suite.
- [`running-openclaw-tests.md`](./running-openclaw-tests.md) — setup, credentials, scenario selection, fixtures, artifacts, and maintenance notes.
- [`openclaw-test-architecture.md`](./openclaw-test-architecture.md) — the harness internals (topology, Dockerfiles, mocked CLIs, scenarios, artifacts, judge).

## Running the suite

[Running the OpenClaw Tests](./running-openclaw-tests.md) is the operator guide for the AlignDev harness. It covers setup, safe artifact handling, representative scenario selection, justified coverage expansion, and the ticket-id convention.

## Deployment

The setup skill owns creation and deployment. Its
[`aligndev-openclaw.md`](../../skills/alignfirst-setup-guide/references/aligndev-openclaw.md)
reference assembles a version-controlled admin repository from a common base plus one channel
overlay, one coding-agent overlay and the optional dev-server gateway. The generated runbooks derive
configuration from the installed OpenClaw version, keep secrets outside git, and prepare managed
projects through the complete AlignDev contract.

### Native-directory selection

Ordinary developer setup omits `configDir` to inherit the caller's native directory variable unless profile `env`/`unset` changes it. Deployments instead require null or a string for every coding profile and enabled explicit quota source. Generated service defaults use null, removing `CLAUDE_CONFIG_DIR`, `CODEX_HOME` or `PI_CODING_AGENT_DIR` so native defaults apply. Custom strings resolve and set the variable; even a string naming the default path remains an explicit selection.

The inventory maps null to the native default beneath the service home and always emits an absolute filesystem path. Authentication/status, configuration/trust, package installation, readiness and update/recovery commands must read mode from the relevant named profile/quota settings, then unset or set the variable after login-shell initialization. Filesystem operations retain the inventory path. Stores deduplicated by path may still need different native invocation modes; coding and explicit quota selections remain independent.

Pi rendering separates `PI_CONFIG_DIR_JSON` (raw JSON null or an encoded string) from `PI_CONFIG_DIR_DISPLAY` (human-facing text). `PI_QUOTA_JSON` is a raw JSON object, with a null/string directory for an enabled native source or only `{"source":"none"}`. These typed values are substituted without surrounding quotes; `PI_CONFIG_DIR` is obsolete.

Confirm the intended mode before changing an existing string. Upgrade the CLI, inventory/policy helpers, settings and matching runbooks together through controlled maintenance; no settings conversion is automatic. On macOS, explicitly setting Claude's default path can select different Keychain credentials from leaving the variable unset. A null reset affects only directory routing, not HOME, PATH or API-key precedence; it includes no login or credential transfer. Authenticate under the same effective environment and cwd as the selected child or quota source.

### Pi deployment gate

Pi deployment templates target Pi 1.3.0 on both Slack and Discord. The earlier credential-policy blocker was resolved by explicit approval of one exception: `<agent-dir>/auth.json` remains private, service-owned and writable/replaceable, including adjacent locking, for normal native OAuth login and automatic credential/refresh-token renewal. It can also declare executable API-key commands. Another process under that UID can persist a command for later Pi execution with the account's privileges. This is account-level persistence, not administrator privilege escalation. Permissions cannot distinguish native renewal from other same-UID writers.

All other managed instructions, settings/resource declarations, extensions, skills, npm/git package trees, native `bin` helpers, trust and path anchors retain controlled-maintenance protection. Root-owned sticky writable native anchors permit auth/session/cache writes without permitting replacement of root-owned managed entries. Do not freeze the whole native directory. Project trust governs discovery, not an OS sandbox or protection against project changes. Record one manually approved dedicated project/worktree parent; never silently trust the entire projects root.

The protected launcher verifies the pinned npm package's `bin.pi` and execs `/usr/bin/node` with its protected CLI entry, preserving cwd, arguments, environment and project PATH. Packaged subagents reuse `process.execPath`. Both installed inventory/policy helpers run from root-owned `/opt/<service-user>/libexec`, not the mutable seed. They inventory all child and optional quota stores, reject ambiguous paths, aliases/overlaps and escaping package links, and retain resolved pre-unlock inventories for failure restoration. Native backup/recovery uses private explicit destination mappings and exact replacement, not a merge of executable trees. See the setup reference's [deployment boundary](../../skills/alignfirst-setup-guide/references/aligndev-openclaw.md#deployment-gate) and generated runbooks.

After building `alignfirst` and `aligndev`, run `npm run test:deployment-templates`. The stdlib suite renders three agents × two surfaces with gateway/work-files options, checks default/custom and multi-profile inventory, JSON, dotfiles, script syntax, executable modes, real AlignDev validation and managed-block idempotence. Native tests preserve the original command-persistence/permission evidence with fake credentials, disposable state and network rejection; they also exercise no-model startup, native locks and neutral reserved resources. Rewritten maintenance fixtures use audited privileged-command doubles for success, failure, signals, partial unlock, snapshot restoration and backup mapping. Runtime fixtures prove project-tool Node selection and packed subagent reuse. These observations do not certify kernel ownership/immutable enforcement or real containment.

OpenClaw remains the persistent parent and needs no `pi-background` to delegate. Production headless waiting remains unchanged and independently blocked under B7. Real service-user enforcement, OAuth login/renewal, reboot, recovery and channel-conversation acceptance remain unexecuted by this template work.
