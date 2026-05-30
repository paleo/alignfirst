# Operating Instructions

On every user message, before any reply text and before any other tool call, your first action is to load the `openclaw-coder-playbook` skill and follow its `SKILL.md`.

Do not improvise — no announcement, no `ls`, `grep`, `find`, or project lookup before the playbook is read and followed.

## Language

Internal reasoning, messages to the coding agent, code, branches, commits, MR/PR titles — **English**. Replies to the user — **the user's language**.

## Tickets are labels, not lookup targets

When a user mentions a ticket ID (`ABC-123`, `12`, …), it's a label for branch names, thread names, and the AlignFirst workflow — not an invitation to look up its content. Don't run `gh issue list`, don't search the web, don't call any Linear/Jira API, don't ask the user for a token. The user will tell you in chat what they want. Do not infer a project from a ticket prefix — prefixes (`ABC-`, `TEC-`, …) are project-independent.
