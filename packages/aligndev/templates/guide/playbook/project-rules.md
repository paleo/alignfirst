# Runbook: Project rules

Run `{{ALIGNFIRST}} config --json` from the selected worktree before editing instructions. Use the nullable `locations.assistantInstructionsFile` to identify the configured file; its path and existence are explicit. Use `locations[".alignfirst-instructions"]` for coding-agent companion context, with `.alignfirst-instructions/context.md` in place of `AGENTS.md`. The agent edits selected companion files in place. They are outside the repository, so no branch or pull request is involved.

Two triggers, both edited through the agent:

- You learn something non-obvious about how to work in a project — a command, a quirk, a convention not yet written down. Propose capturing it in the resolved configured assistant-instructions file, ask for confirmation, then have the agent make the edit. With no reference, propose a suitable file and an explicit `assistantInstructionsFile` entry in the selected configuration, respecting its logical item placement; obtain approval before creating either.
- The user asks to retain a rule for the project. No confirmation needed for the requested rule: retain it in the resolved assistant-instructions file and, when relevant to coding, the coding-agent instructions. With no configured reference, obtain approval for a suitable file and explicit `assistantInstructionsFile` setting before writing. Keep these audiences distinct; do not copy entire documents between them.

{{#thread}}
When the thread has an active ticket and the rule is simple, add it on the current branch, so the ticket's PR carries it. When the rule is complex or the thread has no ticket, reserve a side ticket (`{{GUIDE}} side-ticket`), set up a workspace on a new branch for the rule, and create a pull request.
{{/thread}}
{{#conversation}}
When the session has an active ticket and the rule is simple, add it on the current branch, so the ticket's PR carries it. When the rule is complex or the session has no ticket, reserve a side ticket (`{{GUIDE}} side-ticket`), set up a workspace on a new branch for the rule, and create a pull request.
{{/conversation}}

{{#openclaw}}
A rule that is not about a project has no home: the workspace files are read-only and no memory persists across sessions. Answer that the rule cannot be shared with later sessions, and do not try to store it.
{{/openclaw}}
{{#codingAgent}}
A rule that is not about a project belongs in the developer's own global instructions, which you do not edit. Tell the user so.
{{/codingAgent}}

## The project's entry points

A project has up to three entry points:

- `README.md` — presentation, getting-started procedure…
- The explicitly configured assistant instructions — the agent's user, human or AI: you. Run `{{ALIGNFIRST}} assistant-instructions` from the selected worktree. It reports the absolute source path for interpreting relative links. Without a configured reference, it prints project guidance; there is no filename fallback.
- `AGENTS.md` — the agent. When the project's instructions come from its companion, the companion's `.alignfirst-instructions/context.md` replaces it for the agent, and `{{ALIGNFIRST}} context` prints it.

The rest of the documentation (`docs/`, …) addresses everybody.
