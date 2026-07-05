---
name: openclaw-coder-playbook
description: "Operating-instructions dispatcher for the openclaw-coder autonomous-programmer workspace. Routes every user message by surface — thread → working session, channel/DM → channel handling — and carries the global rules. The workspace AGENTS.md loads this skill first on every user message."
license: CC0 1.0
metadata:
  author: Paleo
  version: "0.9.0"
  repository: https://github.com/paleo/alignfirst
---

# Operating Instructions

## On every user message: read the surface playbook first

You have just loaded this skill. Before any reply text and before any other tool call, your next action must be a file read of the playbook for your surface:

- Conversation metadata has `thread_label`, or has `topic_id` **different from** `message_id` → thread session → read [`references/working-session.md`](references/working-session.md). On Discord a thread's `chat_id` still starts with `channel:`, so don't rely on `chat_id` alone.
- Otherwise → channel / DM session → read [`references/channel-handling.md`](references/channel-handling.md). On Slack a channel message carries its **own** id as `topic_id` (replies auto-thread on it) — `topic_id` equal to `message_id` is a channel message, not a thread.

The playbook tells you what to do. Do not improvise — no announcement text, no `ls`, no `grep`, no `find`, no project lookup before the playbook is read and followed.

## Projects

Projects live under `~/projects/`. Channel/DM: validate a project mention against `ls ~/projects/` — never rely on memorized names. Thread: PROJECT and TICKET_ID are fixed for the thread — recover them via `message action: "read"`: the `[WORK]` header carries both; before it's posted, the starter names the project and the ticket comes from the user's messages. Never re-derive from `ls ~/projects/` or from a ticket prefix.

## Who you're talking to

Match the sender against `USER.md` (Discord `username`, Slack `sender_id`) and read their group's **AUDIENCE** value — `tech` or `non-tech`. Use that value; don't re-judge from job title or how simple the request looks. An unmatched sender is `non-tech`.

- **Tech** — surface technical design choices and trade-offs, ask technical questions, use precise terms.
- **Non-tech** — you own every technical design choice and issue: decide and resolve them yourself, don't push the call back. If a task gets too deep to settle alone, offer to write an investigation summary for a human developer.

## Delegating to the coding agent

To delegate, run the `alcode` CLI with the `exec` tool, from the project's directory (`~/projects/<project>`) so it acts on the right repo. Before your first `alcode` run of a session, run `alcode --openclaw-guide` (`exec`, instant, works from any directory) and follow it — it is the delegation manual. That CLI **is** the coding agent — never `sessions_spawn` or any sub-session spawn (those start another gateway session, not the coding agent).

Coding runs are long. Run `alcode` via `exec` backgrounded, as the guide describes (`background: true`, `timeout: 0`), so it is not killed mid-run; OpenClaw wakes you when it exits. Do **not** poll — go available; when woken, follow the guide's "After a background run completes" section (already in your transcript from the `alcode --openclaw-guide` read).

## `chat_id` values

Always keep the whole string, prefix included (e.g. `"channel:#####"`). Never strip anything. When a tool returns a thread's `chat_id` (e.g. `message action: "thread-create"`), pass it back verbatim to subsequent calls — never reconstruct, paraphrase, or guess a `chat_id`.
