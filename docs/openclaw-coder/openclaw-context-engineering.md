# OpenClaw Context Engineering

How OpenClaw assembles the agent's context — what gets auto-loaded, what doesn't, and the budgets that bound it. Source verified against the upstream repo (`src/agents/workspace.ts`, `bootstrap-cache.ts`, `system-prompt.ts`, `bootstrap-budget.ts`). A read-only clone lives at `openclaw-coder/.local/openclaw/` for spot-checking.

When you actually edit a workspace file, also read [`writing-instructions-for-openclaw.md`](./writing-instructions-for-openclaw.md) — heuristics from past test regressions.

## Workspace bootstrap files (auto-loaded each turn)

These top-level files under `~/.openclaw/workspace/` are read on every turn and injected into the system prompt:

- `AGENTS.md` — operating instructions (required)
- `TOOLS.md` — local tool conventions (required)
- `SOUL.md`, `IDENTITY.md`, `USER.md` — persona / context (optional)
- `MEMORY.md` — curated long-term memory (optional)
- `BOOTSTRAP.md` — first-run ritual (optional)
- `HEARTBEAT.md` — heartbeat checklist (optional, dynamic load)

Loader: `loadWorkspaceBootstrapFiles()` in `src/agents/workspace.ts`. The bootstrap cache (`src/agents/bootstrap-cache.ts`) refreshes per turn keyed on inode/mtime, so live edits are picked up without restarting the gateway. This is why the harness can bind-mount the workspace and the playbook skill into the gateway and have playbook edits iterate without a rebuild.

## Subagent sessions get a filtered subset

When a session is spawned (e.g. `sessions_spawn` with `context: "isolated"`), only `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `TOOLS.md` are injected. `MEMORY.md`, `BOOTSTRAP.md`, `HEARTBEAT.md` are stripped. Filter: `filterBootstrapFilesForSession()` in the same file.

## Nested files are not auto-loaded

Anything under `workspace/` subdirectories is **not** auto-injected. The agent must read it on demand via a tool. Markdown links from a bootstrap file (`[file-name.md](docs/file-name.md)`) are hints, not pre-expanded.

To force-load extra files into the prompt, configure the `bootstrap-extra-files` hook in `openclaw.json`. Caveat: the file basename must be one of the recognized bootstrap names (`AGENTS.md`, `SOUL.md`, …) — you can't smuggle arbitrary content this way.

This is the mechanism the `openclaw-coder-playbook` skill relies on: `AGENTS.md` is a thin pointer that, on the first user message, tells the agent to load that skill and read its `SKILL.md` (the dispatcher); the dispatcher in turn reads the surface-specific procedure (`references/working-session.md` or `references/channel-handling.md`). None of those files is auto-loaded — they cost tokens only when a turn actually needs them. Because the catalog injects only name+description (never the body), whichever `SKILL.md` the agent reads *first* sets the turn's frame — which is why the dispatcher is a procedural skill and the delegation manual (`alcode --guide`) is only read at delegation time.

## Character budgets

Defaults in `src/agents/bootstrap-budget.ts`:

- `agents.defaults.bootstrapMaxChars`: 12 KB per file
- `agents.defaults.bootstrapTotalMaxChars`: 60 KB total

Over-budget files are truncated with a marker. Keep workspace files under these limits.

## Practical implications

- Keep top-level workspace files lean — every turn pays the token cost.
- Push everything situational (per-surface playbooks, per-project welcome docs) into nested files referenced by name from `AGENTS.md` / `TOOLS.md`. The agent reads them only when relevant.
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
- Thread messages → the thread's bound session: a subagent we spawned with `thread: true`, or, with auto-thread routing enabled (Slack-style), a fresh thread-session OpenClaw spins up on first inbound message in the thread.

### Outbound delivery (the surprising part)

Two regimes coexist:

- **Channel / DM / thread sessions** auto-stream their model text to their bound surface (block-streaming per `channels.discord.streaming`/`channels.slack.streaming`). Just generating text replies works — no tool call needed. For *cross-surface* posting (open a thread, post into a different channel than the bound one, send attachments, react), the session uses the `message` tool with explicit targets.
- **Subagent sessions** do **not** auto-stream. OpenClaw forces `requireExplicitMessageTarget=true` for subagent sessions (`src/agents/pi-embedded-runner/run/attempt.ts`) and the subagent system prompt actively discourages calling `message`: *"only use the `message` tool when explicitly instructed to contact a specific external recipient; otherwise return plain text and let the parent deliver it"* (`src/agents/subagent-system-prompt.ts`).

So a thread-bound subagent's intermediate turns produce **no** Discord posts. The only delivery is the **announce-relay**: when the subagent finishes a turn, OpenClaw re-prompts the *parent* in-process with a synthetic `[Internal task completion event] … Action: send a user-facing update now` injection (`src/agents/subagent-announce.ts`), and the parent calls `message` to post into the thread. **One relay per subagent lifecycle.** Anything the subagent emitted along the way is invisible to the user.

This is why "a subagent talks to the user directly" doesn't work without effort — the architecture is **subagent → parent → user**, not **subagent → user**. To get live, multi-turn thread interactivity, don't use a subagent at all (Path 3 below) — use a regular thread session, which has auto-stream.

### Patterns for thread work

Three viable shapes for handling a Discord thread, given the above:

1. **Parent-relayed subagent** (matches defaults). Spawn a thread-bound subagent; it works headless; the parent relays its single final summary into the thread. No live progress.
2. **Subagent uses `message` with explicit target** (against OpenClaw guidance). Pass the thread channel ID into the subagent's bootstrap; have it call `message` for each progress step. Supports live progress, fragile, fights the system prompt.
3. **Auto-thread routing — no subagent**. Configure the Discord channel so the bot's reply auto-opens a thread and subsequent thread messages route to a fresh thread session (the Slack model). Channel and thread sessions are siblings, each owning its surface. Loses subagent isolation; matches the per-surface session model naturally.

**Chosen for openclaw-coder:** Path 3, with a Discord twist. Slack uses the built-in auto-thread (`replyToMode: "all"`), so every reply auto-threads. On Discord, that knob (`autoThread`) would thread *every* channel message, which we don't want — the channel session decides when to open a thread via `message` `action: "thread-create"`, and follow-up thread messages route to a fresh per-thread session.

### Wiring it up

The channel session opens a thread on demand via the `message` tool with `action: "thread-create"` (`extensions/discord/src/channel-actions.ts`, handler in `extensions/discord/src/actions/`). Subsequent posts in the thread go through `message` `action: "thread-reply"`. Routing of the user's follow-up messages to a fresh per-thread session is handled by `resolveThreadSessionKeys` (`extensions/discord/src/monitor/`) and depends only on the message's `threadId`, not on how the thread was created.

The `message` tool is profile-gated. Default tool profiles place it under `messaging` only (`src/agents/tool-catalog.ts`); the `coding` profile excludes it. The supported widening knob is `tools.alsoAllow` (merged in `src/agents/pi-tools.policy.ts`):

```jsonc
{
  "tools": {
    "profile": "coding",
    "alsoAllow": ["message"]
  }
}
```

Without `alsoAllow`, the channel session falls back to raw Discord REST via `exec` + `curl`. That still works for thread creation (and the thread-session routing still kicks in, since `resolveThreadSessionKeys` looks at the inbound `threadId` regardless of origin), but you lose transcript persistence, secret redaction, streaming previews, rate-limit retries, and observability through the standard tool result pipeline. Don't take the curl shortcut.

### Discord vs Slack thread history — upstream gap

When a fresh thread session activates on Discord on the user's follow-up, its transcript starts **empty** — Slack injects a `ThreadHistoryBody` of up to `thread.initialHistoryLimit` (100) prior messages, but Discord has no equivalent path (the API capability exists in `readMessagesDiscord()`, just not wired into thread-session init).

Workaround: the thread playbook ([`working-session.md`](../skills/openclaw-coder-playbook/references/working-session.md)) instructs the agent to call `message` `action: "read"` with its bound `threadId` whenever its transcript is empty. The system prompt's `MESSAGE_TOOL_THREAD_READ_HINT` string (in `src/agents/tools/message-tool.ts`) is written for this case.

## `expectsCompletionMessage` — let a thread subagent speak for itself

`sessions_spawn` also accepts `expectsCompletionMessage: boolean` (default `true`). When `true`, OpenClaw injects a synthetic user-role message into the **parent's** transcript as soon as the child finishes a turn:

```text
[Internal task completion event]
…
Action:
A completed subagent task is ready for user delivery. Convert the result above
into your normal assistant voice and send that user-facing update now.
```

The "Action:" line is hardcoded in `src/agents/subagent-announce.ts` (`buildAnnounceReplyInstruction()`) — it forces the parent to relay/summarize and cannot be overridden with prompt instructions in any local file (it's appended *after* them in the parent's user-role turn input).

For a thread-bound subagent that already talks to the user directly in its own Discord thread (`thread: true, mode: "session"`), this is exactly the wrong default — the parent ends up double-posting. **Pass `expectsCompletionMessage: false`** to suppress the synthetic message entirely; the subagent's reply lands in the thread and the parent stays silent.

Per-session, runtime-configurable knob only — no global setting. There's an `agents.defaults.subagent.announceTimeoutMs` for delivery timeout, but nothing to disable the action text or switch defaults.

### Announce-reply routing — by subagent binding, not parent session

When the parent does react to the announce (default, `expectsCompletionMessage: true`), its reply is **not** routed to the parent's bound channel as the session key suggests. Empirical observation on Discord: a parent session keyed `agent:main:discord:channel:<channelId>` whose subagent was spawned `thread: true` posts its announce-reply **into the thread**, not into the parent channel.

So the destination follows the **child's** binding, not the parent's. Worth knowing if you keep the announce enabled and want to predict where the reply appears — set `expectsCompletionMessage: false` whenever the subagent already owns the user-facing surface.

## Debugging: see what the model actually receives

The agent is otherwise a black box. A handful of env vars unlock raw introspection. Set them on the gateway's environment (for a `systemd --user` gateway, a drop-in like `openclaw-gateway.service.d/debug.conf`; in the test harness, on the `gateway` service in `docker-compose.yml` or via `.env.local`).

| Var | What it captures | Output |
| --- | --- | --- |
| `OPENCLAW_ANTHROPIC_PAYLOAD_LOG=1` | Full Anthropic API request + response per turn (system prompt, tools, messages, model output). The most useful single flag. | `~/.openclaw/logs/anthropic-payload.jsonl` |
| `OPENCLAW_RAW_STREAM=1` | Raw event stream the runtime emits (messages, tool calls, responses) as JSONL. Override path with `OPENCLAW_RAW_STREAM_PATH`. | `~/.openclaw/logs/raw-stream.jsonl` |
| `OPENCLAW_CACHE_TRACE=1` (+ `OPENCLAW_CACHE_TRACE_SYSTEM=1`, `OPENCLAW_CACHE_TRACE_PROMPT=1`) | Anthropic prompt-cache breakpoints and reuse. Useful to verify the bootstrap files land in a cached prefix. | `~/.openclaw/logs/cache-trace.jsonl` |
| `OPENCLAW_DEBUG_MODEL_PAYLOAD=tools\|summary\|full-redacted` | Stderr summary of each model call. Lighter than the payload log. | stderr / journal |
| `OPENCLAW_TRAJECTORY_DIR=<path>` | Redirect the always-on per-session trajectory logs (full conversation history) elsewhere. | per-session JSON |

Trajectories are written by default under `~/.openclaw/logs/trajectory/` and can be extracted with `openclaw export-trajectory --sessionKey <key>`.

In the test harness, the gateway's `~/.openclaw/logs/` is bind-mounted to `playbook-test/.gateway-logs/`. The scenario runner parses the per-session `trajectory/*.jsonl` from there to attribute per-turn tool calls and cost (provider-neutral — works under any LiteLLM provider); if the dir is absent (logging disabled, or the dir is unwritable) the runner logs `agentToolCall parsing skipped: … trajectory not found` and reports `agentTurns: 0`. The trajectory log is default-on (disable with `OPENCLAW_TRAJECTORY=0`); ensure `.gateway-logs/` is writable by your user when you need the trace.

Disable the debug vars once done — the JSONL files grow per turn.
