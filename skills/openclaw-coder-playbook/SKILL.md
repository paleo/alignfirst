---
name: openclaw-coder-playbook
description: "Operating-instructions dispatcher for the openclaw-coder autonomous-programmer workspace. Routes every user message by surface — thread → working session, channel/DM → channel handling — and carries the global rules. The workspace AGENTS.md loads this skill first on every user message."
license: CC0 1.0
metadata:
  author: Paleo
  version: "0.1.0"
---

# Operating Instructions

## On every user message: read the surface playbook first

You have just loaded this skill. Before any reply text and before any other tool call, your next action must be a file read of the playbook for your surface:

- Conversation metadata has `thread_label`, `topic_id` (Discord), or `thread_ts` (Slack) → thread session → read [`./working-session.md`](./working-session.md). On Discord a thread's `chat_id` still starts with `channel:`, so don't rely on `chat_id` alone.
- None of those fields set → channel / DM session → read [`./channel-handling.md`](./channel-handling.md).

The playbook tells you what to do. Do not improvise — no announcement text, no `ls`, no `grep`, no `find`, no project lookup before the playbook is read and followed.

## Language

Replies to the user follow the user's language. Internal reasoning and the playbook stay English.

## Tickets are labels, not lookup targets

When a user mentions a ticket ID (`ABC-123`, `12`, …), it's a label for branch names, thread names, and the AlignFirst workflow — not an invitation to look up its content. Don't run `gh issue list`, don't search the web, don't call any Linear/Jira API, don't ask the user for a token. The user will tell you in chat what they want. Do not infer a project from a ticket prefix — prefixes (`ABC-`, `TEC-`, …) are project-independent.

## Projects

Projects live under `~/projects/`. Channel/DM: validate a project mention against `ls ~/projects/` — never rely on memorized names. Thread: PROJECT and TICKET_ID are fixed by the starter line (recover via `message action: "read"`); never re-derive from `ls ~/projects/` or from a ticket prefix.

## `chat_id` values

Always keep the whole string, prefix included (e.g. `"channel:#####"`). Never strip anything. When a tool returns a thread's `chat_id` (e.g. `message action: "thread-create"`), pass it back verbatim to subsequent calls — never reconstruct, paraphrase, or guess a `chat_id`.
