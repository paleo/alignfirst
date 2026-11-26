# Runbook: Project rules

Run `{{ALIGNFIRST}} config --json` from the selected worktree before editing instructions. `locations.assistantInstructionsFile` names the project's assistant-instructions file, with its path and existence. Use `locations[".alignfirst-instructions"]` for coding-agent companion context, with `.alignfirst-instructions/context.md` in place of `AGENTS.md`. The agent edits selected companion files in place. They are outside the repository, so no branch or pull request is involved.

Two triggers, both edited through the agent:

- You learn something non-obvious about how to work in a project — a command, a quirk, a convention not yet written down. Propose capturing it in the assistant-instructions file, ask for confirmation, then have the agent make the edit. The agent creates the file when it is missing.
- The user asks to retain a rule for the project. No confirmation needed for the requested rule: retain it in the assistant-instructions file and, when relevant to coding, the coding-agent instructions. Keep these audiences distinct; do not copy entire documents between them.

{{#thread}}
When the thread has an active ticket and the rule is simple, add it on the current branch, so the ticket's PR carries it. When the rule is complex or the thread has no ticket, reserve a side ticket (`{{GUIDE}} side-ticket`), set up a workspace on a new branch for the rule, and create a pull request.
{{/thread}}
{{#conversation}}
When the session has an active ticket and the rule is simple, add it on the current branch, so the ticket's PR carries it. When the rule is complex or the session has no ticket, reserve a side ticket (`{{GUIDE}} side-ticket`), set up a workspace on a new branch for the rule, and create a pull request.
{{/conversation}}

{{#openclaw}}
A rule that is not about a project belongs to the operator, who writes the workspace files and the global assistant instructions. No memory persists across sessions. Answer that the operator can add the rule, and do not store it.
{{/openclaw}}
{{#codingAgent}}
A rule that is not about a project has two homes. A rule for you, the assistant, belongs in the global assistant instructions. A rule for the coding agent belongs in the developer's own global instructions, which you do not edit. Tell the user where the rule belongs.
{{/codingAgent}}

## The project's entry points

A project has up to three entry points:

- `README.md` — presentation, getting-started procedure…
- The project's assistant instructions — the agent's user, human or AI: you. Run `{{ALIGNFIRST}} assistant-instructions` from the selected worktree. Its block carries the file's absolute path, for interpreting relative links. Without a file, it prints the project guidance alone.
- `AGENTS.md` — the agent. When the project's instructions come from its companion, the companion's `.alignfirst-instructions/context.md` replaces it for the agent, and `{{ALIGNFIRST}} context` prints it.

The rest of the documentation (`docs/`, …) addresses everybody.
