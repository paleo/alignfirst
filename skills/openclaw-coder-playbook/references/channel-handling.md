# Channel handling

You're running in a channel (Slack) or channel/DM (Discord). Your job: triage incoming user messages and, when a project is named, open a thread and **continue the setup work inside the thread in this same turn**.

## Interpreting requests

Projects live under `~/projects/`. Discover the current list by inspecting that directory — do not rely on memorized names.

**First decision: is the message actionable?** A message is actionable when it mentions a project, a ticket id, or both — anything that signals work intent.

- **Not actionable** (greeting, small talk, unrelated chatter) — off-projects chatter. Reply naturally in place. On Discord, channel reply; on Slack, normal reply (auto-threaded).
- **Actionable** — open a thread (Discord `thread-create`; Slack auto-threads on reply). FS-checking a named project happens *after* the thread is open, not before. A missing project, an unknown name, or a missing ticket is handled inside the thread — never as a refusal in the channel.

## Actionable message: open a thread, then continue in-turn

The moment you detect an actionable mention, prepare a thread for a fresh session to take over.

### Starter message (`STARTER_MESSAGE`)

The fresh session won't have access to the channel's transcript — only to the user's last message. If there is *additional* context from earlier in the channel that helps interpret it (constraints, leads, files to touch, decisions already made), include it explicitly — sharp and concise — in `{ANNOUNCEMENT}`.

**Don't restate the user's last message.** Don't narrate the user in third person ("the user is asking…"). When there's nothing extra to add, `{ANNOUNCEMENT}` is just the announcement — see examples below.

Use this exact template so the variables stay easy to grep for:

```text
Project: **{PROJECT}** — Ticket: **{TICKET_ID}** — Requester role: **{USER_ROLE}**
{ANNOUNCEMENT}
```

- `{USER_ROLE}` — match the inbound sender against `USER.md`. On Discord, match the `username` field; on Slack, match the `sender_id`. If no entry matches, fall back to `guest`.
- `{PROJECT}` or `{TICKET_ID}` missing — write `?` (e.g. `Project: **?**`).
- Multiple projects: write them joined with `+`.

When you have no extra context to add, `{ANNOUNCEMENT}` is a short announcement. Vary the wording. English examples (translate to user's language):

- "Opening a new thread."
- "Starting a thread."
- "New thread."

**The starter is announcement only.** Zero questions — not even a vague "what's the task?", "qu'est-ce qu'on fait ?", "tell me more". Anything you need to ask goes in a **separate follow-up message** inside the thread (see below).

#### Discord — open the thread via `message` action `thread-create`

Call the `message` tool (see `TOOLS.md` for the full schema) with:

- `action`: `"thread-create"`
- `target`: the **raw `chat_id`** from inbound metadata.
- `messageId`: the user's triggering message ID from inbound metadata (this opens the thread anchored on the user's message)
- `threadName`: `<TICKET_ID> - <PROJECT> - <1-to-5-word description>`. Multiple projects: `<TICKET_ID> - <PROJ_A>+<PROJ_B> - <desc>`.
- `message`: `{STARTER_MESSAGE}`
- `channel`: `<channel>`

The tool returns the new thread's `chat_id` (which becomes our `THREAD_ID`). Capture it.

When opening a thread, the `thread-create` call must be your *first* user-facing action. Once the thread exists, all further posts in this turn go through the `message` tool with the thread's `threadId`; free-form text would auto-stream into the parent channel.

#### Slack — just reply (Slack auto-threads)

On Slack your reply auto-opens a thread (`replyToMode: "all"`). The reply itself plays the role of the thread starter — your *first* user-facing text must be the STARTER_MESSAGE, with no preamble. For the next steps, continue emitting text normally; Slack auto-threads everything that follows.

### Continue inside the thread — IN THIS SAME TURN

**Do not end your turn after creating the thread.** The thread session won't activate until the next user message, so anything actionable must happen now. Branch on what's known:

- **PROJECT + TICKET_ID known** — **WORK mode**. **Read [`project-workspace-setup.md`](./project-workspace-setup.md) first**, then follow its procedure. It tells you how to detect an existing branch/worktree and reuse them — do not bypass it by running `git` or `ls` or any CLI on the project directly. Applies to code changes, status updates, and any other request that benefits from a worktree.
- **PROJECT known, TICKET_ID unknown** — **TALK mode**. No worktree. Branch on the request:
  - User posed an investigation/advice question (`why X?`, `should we Y?`, `comment X ?`) → delegate the question to the coding agent via the `alignfirst-agent` skill without a protocol header. Trust the project; do not pre-screen. Post the agent's reply back in the thread as a summary.
  - User signaled work intent without enough info (`on a un truc à faire sur X`, `we need to work on X`) → ask in-thread for the ticket id and the scope/type. End turn.
  - A TALK thread can later be promoted to WORK if a ticket appears.
- **TICKET_ID known, PROJECT unknown** — Ask in-thread which project the ticket belongs to. Restate the ticket id in the question (e.g. `Pour le ticket ABC-123, sur quel projet travaille-t-on ?`). End turn.
- **PROJECT FS-check fails** — the named project is not a directory under `~/projects/`. Acknowledge the missing project; ask the user to confirm or correct. End turn.
- **PROJECT unclear / generic chatter** — Ask the user to clarify. End turn.
- **Multiple projects + TICKET_ID + code change** — WORK per project. FS-check each. For every project that exists, follow [`project-workspace-setup.md`](./project-workspace-setup.md) in this same turn (one worktree per project, same ticket id). Report status at the end. If any project's FS-check fails, acknowledge that one and continue with the others.

Subsequent user messages in the thread route to a **fresh thread session**.

## Off-projects messages

Reply naturally, in the user's language. On Discord, auto-streaming posts your text in the parent channel — no tool call needed. On Slack, your reply auto-threads. Either way: no `thread-create`, no setup, no coding-agent call.
