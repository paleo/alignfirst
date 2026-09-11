# OpenClaw Context Engineering

How OpenClaw assembles the agent's context — what gets auto-loaded, what doesn't, and the budgets that bound it. Source verified against the upstream repo (`src/agents/workspace.ts`, `bootstrap-cache.ts`, `system-prompt.ts`, `embedded-agent-helpers/bootstrap.ts`). A read-only clone lives at `.local/openclaw/` for spot-checking.

When you actually edit a workspace file, also read [`writing-instructions-for-openclaw.md`](./writing-instructions-for-openclaw.md) — heuristics from past test regressions.

## Workspace bootstrap files (auto-loaded each turn)

These top-level files under `~/.openclaw/workspace/` are read on every turn and injected into the system prompt:

- `AGENTS.md` — operating instructions (required)
- `SOUL.md`, `IDENTITY.md`, `USER.md` — persona / context (optional)
- `MEMORY.md` — curated long-term memory (optional)
- `BOOTSTRAP.md` — first-run ritual (optional)

Loader: `loadWorkspaceBootstrapFiles()` in `src/agents/workspace.ts`. The bootstrap cache (`src/agents/bootstrap-cache.ts`) refreshes per turn keyed on inode/mtime, so live edits are picked up without restarting the gateway. This is why the harness can bind-mount the workspace and the playbook skill into the gateway and have playbook edits iterate without a rebuild.

## Subagent sessions get a filtered subset

A spawned session (e.g. `sessions_spawn` with `context: "isolated"`) receives only `AGENTS.md`; every other bootstrap file is stripped. Cron sessions receive `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, and `USER.md`. Subagent, cron, group, and channel sessions additionally drop the root `MEMORY.md` for privacy. Filter: `filterBootstrapFilesForSession()` in the same file.

`TOOLS.md` is retired. OpenClaw 2026.8+ neither loads nor recreates it, so AlignFirst workspaces no longer ship the former zero-byte placeholder; tool and environment instructions live in `AGENTS.md`. `openclaw doctor` warns while a leftover file exists, and `--fix` archives it, merging custom content into `AGENTS.md`.

## Nested files are not auto-loaded

Anything under `workspace/` subdirectories is **not** auto-injected. The agent must read it on demand via a tool. Markdown links from a bootstrap file (`[file-name.md](docs/file-name.md)`) are hints, not pre-expanded.

To force-load extra files into the prompt, configure the `bootstrap-extra-files` hook in `openclaw.json`. Caveat: the file basename must be one of the recognized bootstrap names (`AGENTS.md`, `SOUL.md`, …) — you can't smuggle arbitrary content this way.

This is the mechanism the `alignfirst-developer-openclaw-playbook` skill relies on: `AGENTS.md` is a thin pointer that, on each user message, including the static `Take over this thread.` message from AlignFirst Service, tells the agent to load the skill from OpenClaw's managed `~/.openclaw/skills/` directory and read its `SKILL.md` (the dispatcher); the dispatcher in turn reads the surface-specific procedure (`references/working-session.md` or `references/channel-handling.md`). Neither coding agent scans this managed directory. None of those files is auto-loaded — they cost tokens only when a turn actually needs them. Because the catalog injects only name+description (never the body), whichever `SKILL.md` the agent reads *first* sets the turn's frame — which is why the dispatcher is a procedural skill and the delegation manual (`alcode --openclaw-guide`) is only read at delegation time.

## Character budgets

Defaults in `src/agents/embedded-agent-helpers/bootstrap.ts`:

- `agents.defaults.bootstrapMaxChars`: 20 KB per file; `USER.md` is capped at 4 KB
- `agents.defaults.bootstrapTotalMaxChars`: 60 KB total

Over-budget files are truncated with a marker. Keep workspace files under these limits.

## Heartbeat: cron scratch and `NO_REPLY`

The heartbeat checklist is the scratch of the system-owned `heartbeat:main` cron job (its declaration key; the listing shows it as `Heartbeat (main)`), a row in the shared SQLite store (`src/cron/heartbeat-monitor.ts`, `src/cron/scratch-store.ts`). The gateway creates the job at startup from `agents.defaults.heartbeat.every`; `openclaw cron scratch <job-id>` reads and writes the scratch. The runtime never reads a workspace `HEARTBEAT.md`; `openclaw doctor --fix` imports a leftover file into the scratch and deletes it (`src/commands/doctor-heartbeat-scratch-migration.ts`). A comment-only scratch makes the periodic tick skip its model call (`reason=empty-heartbeat-file`); a missing scratch runs the model.

The general silence convention is `NO_REPLY`. OpenClaw 2026.9.3 can lose a post-tool `NO_REPLY` from its reply accumulator and invoke an isolated finalizer without conversation context, producing an unsolicited answer. The plugin uses `HEARTBEAT_OK` for silent reply runs; ordinary channel and human-turn silence stays on `NO_REPLY`. Disabling block streaming does not avoid the defect.

The configured `agents.defaults.heartbeat.prompt` supplies the generic heartbeat prompt. OpenClaw's stock prompt instructs `NO_REPLY`, and with the key unset it wins over any workspace instruction. The harness and deployment seed currently set an `[OpenClaw heartbeat poll]` instruction requesting immediate `HEARTBEAT_OK`. Native exec completions take a separate `buildExecEventPrompt` branch in `src/infra/heartbeat-runner-prompt.ts`; changing `heartbeat.prompt` does not change that branch. The former `agents.defaults.heartbeat.includeSystemPromptSection` key is rejected.

System events are held in memory (2026.9.x): a queued event does not survive a gateway restart. They are peeked at prompt build and consumed after delivery, so an event survives an aborted heartbeat turn. `enqueueSystemEvent` returns `false` both for a rejection and, with `replace: true`, when an identical event for the same `contextKey` is still queued.

The background `exec` acknowledgement ends with "Use process (list/poll/log/…) for follow-up". On a takeover turn with a 600-second budget, that sentence led the model to poll a backgrounded `alcode` run fifty-five times until the turn was aborted with nothing posted. The delegation guide forbids any `process` call on an `alcode` session.

The saved transcript is not a copy of the live heartbeat prompt. `buildReplyPromptEnvelopeBase` in `src/auto-reply/reply/prompt-prelude.ts` substitutes `HEARTBEAT_TRANSCRIPT_PROMPT` (`[OpenClaw heartbeat poll]`) when saving heartbeat user messages. A transcript showing that marker does not establish which instructions the model received. Use provider payloads to inspect the live prompt. Existing workspace rules that match the marker apply only when that text is actually present in the current prompt.

A completion message chained onto a background `exec` and OpenClaw's native exec completion notice take different prompt branches. When testing the notice, observe the actual event; a generic injected `system event` exercises a different branch. The saved transcript shows the `[OpenClaw heartbeat poll]` marker for both, so it cannot tell them apart either.

Native notices have no short delivery deadline. In `src/infra/heartbeat-cooldown.ts`, a new exec event arriving after the 30-second spacing window can defer until the next configured tick; the harness cadence is 24 hours. Closely spaced events may instead coalesce and run after the spacing window. Completion tests therefore require the real chained process to exit, its report to arrive, and the thread to settle. They record native notices when observed and make no claim about deferred notices outside the observation window.

Heartbeat wakes cannot start a thread reliably. `resolveHeartbeatWakeStage` in `src/infra/heartbeat-runner-execution.ts` skips every intent with `requests-in-flight` while the main command lane is non-empty, whatever the intent; `immediate` bypasses only the per-agent active-run check. `agents.defaults.heartbeat.timeoutSeconds` falls back to the cadence, capped at 600 seconds, against 48 hours for a regular turn. In production on 2026-09-10, two review requests thirty seconds apart left one thread unstarted until a human wrote in it. The plugin therefore dispatches the takeover nudge as a reply run. The `alcode` completion path stays OpenClaw's own; see [`openclaw-plugin.md`](./openclaw-plugin.md).

Plugin-dispatched reply runs use `HEARTBEAT_OK` when they have nothing to report. The deterministic gateway suite established this token on both surfaces: six `NO_REPLY` probes invoked isolated finalization, while six `HEARTBEAT_OK` probes produced neither a finalizer nor an outbound reply.

## Background model runs disabled by the harness and the seed

Three defaults schedule model turns without a user message: the memory-core dreaming sweep (daily, rewrites `MEMORY.md`), the weekly skill-collection review (`skills.workshop.autonomous.mode` defaults to `auto`) and the pre-compaction memory flush (`agents.defaults.compaction.memoryFlush`, writes `memory/YYYY-MM-DD.md`). `memory-core` owns the `memory` plugin slot and loads regardless of `plugins.allow`; `plugins.slots.memory: "none"` removes it along with the `memory_search`/`memory_get` tools. The harness config and the deployment seed set the same opt-outs, plus `update.checkOnStart: false` (the startup update check is also an anonymous version ping).

## Practical implications

- Keep top-level workspace files lean — every turn pays the token cost.
- Push everything situational (per-surface playbooks, per-project welcome docs) into nested files referenced by name from `AGENTS.md`. The agent reads them only when relevant.
- For a subagent's bootstrap task, list prerequisite reads explicitly — the subagent doesn't inherit the parent's read history.
- `sessions_spawn` accepts `task`, `label`, `thread: true|false`, `mode: "session"|"run"`, `context: "fork"|"isolated"`, `runTimeoutSeconds`. `"fork"` inherits the requester's transcript; `"isolated"` starts clean (still gets the filtered bootstrap subset).

## Surfaces, sessions, subagents

Three layers, easy to conflate:

- **Surface** — the chat container the user sees: a Discord DM, channel, or thread; a Slack channel or thread. Owned by Discord/Slack.
- **Session** — OpenClaw's state for one (agent × surface) pair: transcript, workspace bootstrap, prompt cache. Identified by a key like `agent:main:discord:channel:<id>` or `agent:main:subagent:<uuid>`. **Unit of inbound routing**: a user message arrives, OpenClaw picks the one session bound to that surface, and the message becomes the next user turn.
- **Subagent** — a *kind* of session, one that was spawned by another session via `sessions_spawn`. Key always starts `agent:main:subagent:`. With `thread: true`, the subagent is bound to a freshly-created Discord thread and *is* that thread's session.

The user-facing object is the surface. "Subagent" is just one way to attach a session to a thread.

### Inbound routing

One surface = one session at a time. Two surfaces = two transcripts, no shared state. If a user pastes the same message in a channel and in a thread, the bot answers twice from a cold start.

For Discord today:

- Channel messages → channel session (`agent:main:discord:channel:<id>`).
- Thread messages → the thread's regular canonical session unless an explicit subagent binding owns it. The handoff plugin can start that same regular session with a reply run before the first human reply.

A Discord thread is its own channel route: its session key is `agent:main:discord:channel:<threadId>`, indistinguishable from a channel session by key alone. A Slack thread key carries a suffix, `agent:main:slack:channel:<C…>:thread:<ts>`. A session's last delivery route is stored as `SessionEntry.delivery` in 2026.9.3; the legacy `lastChannel` / `lastTo` fields are gone. A bot's own posts never become inbound events, so a bot cannot start a session by posting into the surface.

### Outbound delivery (the surprising part)

Two regimes coexist:

- **Channel / DM / thread sessions** auto-stream their model text to their bound surface (block-streaming per `channels.discord.streaming`/`channels.slack.streaming`). Just generating text replies works — no tool call needed. For *cross-surface* posting (open a thread, post into a different channel than the bound one, send attachments, react), the session uses the `message` tool with explicit targets.
- **Subagent sessions** do **not** auto-stream. OpenClaw defaults `requireExplicitMessageTarget=true` for subagent sessions (`src/agents/command/attempt-execution.ts`) and always denies their `message` tool (`src/agents/agent-tools.policy.ts`). Their model output remains internal until completion routing.

So a thread-bound subagent's intermediate turns produce **no** Discord posts. The only delivery is the **announce-relay**: when the subagent finishes a turn, OpenClaw re-prompts the *parent* in-process with a synthetic `[Internal task completion event]` that asks for parent review and a truthful user-facing update (`src/agents/subagents/announce/subagent-announce.ts`). **One relay per subagent lifecycle.** Anything the subagent emitted along the way is invisible to the user.

This is why "a subagent talks to the user directly" doesn't work — the architecture is **subagent → parent → user**, not **subagent → user**. To get live, multi-turn thread interactivity, don't use a subagent at all (Path 2 below) — use a regular thread session, which has auto-stream.

### Auto-stream delivers turn finals only on Anthropic (the commentary phase)

"Auto-stream" does not mean every text the model writes becomes a post. OpenClaw phase-tags Anthropic assistant text at the `tool_use` boundary: text followed by a tool call in the same run is `phase: "commentary"` (visible as `textSignature` on the trajectory's `messagesSnapshot` blocks), and the embedded subscriber **withholds commentary from durable block replies by design** — `isPhasePendingAnthropicText` in `src/agents/embedded-agent-subscribe.handlers.messages.update.ts`, plus its commentary and stream-phase tests. The channel plugin's deliver callback is never invoked for these texts, so no plugin-side wiring can recover them.

Practical consequences, verified on the harness (2026-07-28, trajectory-vs-bus diff, `claude-sonnet-5`):

- With an Anthropic model, a session's durable posts are its **turn finals** (unphased text ending the run) plus explicit `message` tool-posts. A setup turn that narrates "setting up the workspace", runs tools, then ends on a status line delivers only the status line. Instructions telling the agent to "post" a mid-turn signal produce text that reaches the transcript but never the surface.
- The real plugins do not change this: Discord forwards commentary only in draft-preview *progress* mode (`commentaryPayloadsEnabled` in `extensions/discord/src/monitor/message-handler.process-progress.ts`, ephemeral previews); Slack never does.
- The one durable, production-supported outlet is the **verbose lane** (`agents.defaults.verboseDefault: "on"` or `/verbose on`): commentary items become standalone `💬 <text>` progress messages (`deliverCommentaryProgressMessage` in `src/auto-reply/reply/dispatch-from-config.choose-route.ts`), at the cost of a `🛠️` summary per tool call.
- Provider asymmetry: `openai-completions` providers (qwen, glm) emit unphased text, so their mid-turn text **does** stream at `text_end`. Delivery shape differs per provider; scenario waits and playbook promises must not depend on mid-turn posts existing (Anthropic) or on their absence (qwen/glm).

### Patterns for thread work

Two supported shapes handle a Discord thread:

1. **Parent-relayed subagent** (matches defaults). Spawn a thread-bound subagent; it works headless; the parent relays its single final summary into the thread. No live progress.
2. **Explicit thread plus plugin-dispatched reply run — no subagent**. Deliver a native starter only when the channel triage selects project work, then dispatch a reply run on the canonical thread session. Channel and thread sessions are siblings, each owning its surface.

**Chosen for AlignFirst Developer:** Path 2. Discord keeps channel `autoThread: false` and uses anchored `message thread-create`. Slack keeps `replyToMode: "off"` and uses `message send` with an explicit root timestamp. `@paleo/alignfirst-developer-openclaw-plugin` observes the confirmed native result, persists a pending handoff in its own SQLite database, and calls `runtime.channel.inbound.dispatchReply` with a plugin-built context: `SenderName: "AlignFirst Service"`, no human sender ID, `WasMentioned: false`, and command interpretation suppressed. Its exact message body is `Take over this thread.`; routing and identity stay in context metadata. Core owns final delivery through the adapter's `durable` option with `to`, `threadId`, and `replyToId: null`. The turn's budget is `agents.defaults.timeoutSeconds`. This starts the session without `sessions_send`, a bound subagent, a human nudge, or an official-plugin trust exception.

### Wiring it up

The channel session opens a Discord thread through `message thread-create`, or populates a Slack thread through `message send` with explicit `threadId`. Native Slack automatic root routing would also derive the thread key, but it is disabled so ordinary channel conversation stays at root. The handoff plugin derives that same public canonical route and dispatches a reply run on it. The reply run records the session's last route itself. Later user messages resolve to the route normally. Ordinary replies in the active thread use normal delivery, not another message-tool send.

Two tool-call pitfalls seen in production and model runs. A tool result `Skipped due to queued user message.` means OpenClaw skipped the call because a new message was steered into the turn; the call has to be made again. A Discord `thread-reply` carrying both `target` and `threadId` fails with core's "conflicting target and delivery alias values"; Terra hit it routinely and lost thirty seconds per post on the retry.

#### Delivery receipt shapes

A Slack `send` is prepared by `extensions/slack/src/channel-actions.ts` and handled by core in `src/infra/outbound/outbound-send-service.ts`. Its result details are a `MessageSendResult`: `channel`, `to`, `via`, `result.target`, `result.messageId`, optional `result.receipt.threadId`, and `deliveryStatus`. `src/agents/embedded-agent-message-delivery.ts` adds `messageDelivery`; `details.ok` is absent. A team-qualified target stays on the plugin path and returns `{ ok, result }`, which the handoff plugin does not accept.

Discord `thread-create` stays on the plugin action path and returns `{ ok: true, thread }`, or a partial result when the initial message fails. `after_tool_call` receives the sanitized result plus `sessionKey` and `sessionId`; it receives no channel identity. The handoff plugin joins the event to the source context cached when `src/thread-handoff/tool.ts` instantiated the tool for that session (`src/thread-handoff/index.ts`, `src/thread-handoff/receipts.ts`).

The `message`, `browser`, and optional `thread_handoff` tools are profile-gated. The supported widening knob is `tools.alsoAllow` (merged in `src/agents/agent-tools.policy.ts`):

```jsonc
{
  "tools": {
    "profile": "coding",
    "alsoAllow": ["message", "browser", "thread_handoff"]
  }
}
```

Without `message` in `alsoAllow`, the channel session falls back to raw Discord REST via `exec` + `curl`. That still works for thread creation (and the thread-session routing still kicks in, since `resolveThreadSessionKeys` looks at the inbound `threadId` regardless of origin), but you lose transcript persistence, secret redaction, streaming previews, rate-limit retries, and observability through the standard tool result pipeline. Without `browser`, the workspace's promised browsing capability is unavailable.

### Discord vs Slack thread history — upstream gap

When a fresh thread session activates on Discord, its transcript starts **empty** — Slack can inject a `ThreadHistoryBody` of up to `thread.initialHistoryLimit` (100), but Discord has no equivalent path (the API capability exists in `readMessagesDiscord()`, just not wired into thread-session init).

The channel therefore posts the complete request in the visible starter. After the static takeover message, the playbook claims the current session and reads that starter through `message action: "read"`, combining it with human replies and its transcript. Immediately before its first coding delegation, the takeover turn reads again to catch human instructions that arrived during setup. Human turns also read history to recover answers and `[WORKSPACE]` state. The system prompt's `MESSAGE_TOOL_THREAD_READ_HINT` string (in `src/agents/tools/message-tool-description.ts`) supports the same read path.

### Heartbeat and `agent`-method turns deny external-plugin reads

A heartbeat turn and a turn started by the `agent` method mint no message-action capability. The host gate in `src/channels/plugins/message-action-dispatch.ts` then rejects every conversation-read action (`read`, `search`, `react`, …) of an **external** channel plugin, whatever target the model passes: `Delegated <channel>:read requires the exact current conversation and account for this plugin.` Bundled Slack and Discord declare `providerOwnedReadGates: true`, skip that gate, and fall back to their own channel allow policy. The deterministic suite verifies the gate for the `agent` method.

The `agent` method has a second defect for a thread start: its turn is not a channel reply run. A human message posted in the thread while that turn runs finds no run to queue behind, falls into durable turn admission, fails the session-entry claim in `restart-recovery-claim.ts` (`inbound dispatch failed … restart recovery claim changed before agent adoption`) and is lost. Five model runs showed zero occurrences of the human text in the thread transcript. A turn dispatched through `runtime.channel.inbound.dispatchReply` queues the human message normally.

The plugin's reply runs mint the message-action turn capability without a sender ID. A takeover turn can therefore recover its request through a thread-history read, just as a human turn can. The read uses the current channel, full `chat_id` as `target`, and bare thread ID. The later pre-coding read catches a hold or scope correction queued during setup.

## `expectsCompletionMessage` — control the parent handoff

`sessions_spawn` also accepts `expectsCompletionMessage: boolean` (default `true`). When `true`, OpenClaw injects a synthetic user-role message into the **parent's** transcript as soon as the child finishes a turn:

```text
[Internal task completion event]
…
A completed subagent task is ready for parent review. Otherwise send a truthful
user-facing update.
```

The reply instruction is hardcoded in `src/agents/subagents/announce/subagent-announce.ts` (`buildAnnounceReplyInstruction()`). It asks the parent to review the result and send a truthful user-facing update.

Pass `expectsCompletionMessage: false` only for fire-and-forget work. It suppresses the parent handoff, and the subagent has no direct user-facing delivery path.

Per-session, runtime-configurable knob only — no global setting. There's an `agents.defaults.subagent.announceTimeoutMs` for delivery timeout, but nothing to disable the action text or switch defaults.

### Announce-reply routing — by subagent binding, not parent session

When the parent does react to the announce (default, `expectsCompletionMessage: true`), its reply is **not** routed to the parent's bound channel as the session key suggests. Empirical observation on Discord: a parent session keyed `agent:main:discord:channel:<channelId>` whose subagent was spawned `thread: true` posts its announce-reply **into the thread**, not into the parent channel.

So the destination follows the **child's** binding, not the parent's. Keep the announce enabled when the result must reach that surface.

## Debugging: see what the model actually receives

The agent is otherwise a black box. A handful of env vars unlock raw introspection. Set them on the gateway's environment (for a `systemd --user` gateway, a drop-in like `openclaw-gateway.service.d/debug.conf`; in the test harness, on the `gateway` service in `docker-compose.yml` or via `.env.local`).

| Var | What it captures | Output |
| --- | --- | --- |
| `OPENCLAW_ANTHROPIC_PAYLOAD_LOG=1` | Full Anthropic API request + response per turn (system prompt, tools, messages, model output). The most useful single flag. | `~/.openclaw/logs/anthropic-payload.jsonl` |
| `OPENCLAW_RAW_STREAM=1` | Raw event stream the runtime emits (messages, tool calls, responses) as JSONL. Override path with `OPENCLAW_RAW_STREAM_PATH`. | `~/.openclaw/logs/raw-stream.jsonl` |
| `OPENCLAW_CACHE_TRACE=1` (+ `OPENCLAW_CACHE_TRACE_SYSTEM=1`, `OPENCLAW_CACHE_TRACE_PROMPT=1`) | Anthropic prompt-cache breakpoints and reuse. Useful to verify the bootstrap files land in a cached prefix. | `~/.openclaw/logs/cache-trace.jsonl` |
| `OPENCLAW_DEBUG_MODEL_PAYLOAD=tools\|summary\|full-redacted` | Stderr summary of each model call. Lighter than the payload log. | stderr / journal |

Trajectory capture is default-on (disable with `OPENCLAW_TRAJECTORY=0`). Since 2026.8, the events are SQLite rows in the per-agent store (`~/.openclaw/agents/<id>/agent/openclaw-agent.sqlite`, table `trajectory_runtime_events`); `OPENCLAW_TRAJECTORY_DIR` per-session files are a legacy read path the gateway no longer writes. Extract a session with `openclaw export-trajectory --sessionKey <key>`. Caveat: trajectory payloads run through the diagnostic projection, which caps the whole payload at ~64 nodes — a `model.completed` snapshot keeps only its first few messages, the rest become `"[Truncated]"`.

That cap is why the test harness reads the **session transcripts** instead (`transcript_events` in the same store — the conversation record the gateway replays, appended per message). The scenario runner extracts a conversation's transcripts through the exec-watcher RPC (`transcript-dump.js`) to attribute per-turn tool calls and cost (provider-neutral — works under any LiteLLM provider), and archives them as `transcripts.json` in each cell's artifact dir. If no agent store exists yet, the runner logs `agentToolCall parsing skipped: no agent session store found in the gateway` and reports `agentTurns: 0`.

Disable the debug vars once done — the JSONL files grow per turn.
