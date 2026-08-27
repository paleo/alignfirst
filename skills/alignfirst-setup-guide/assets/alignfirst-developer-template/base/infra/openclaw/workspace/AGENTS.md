# Operating Instructions

On every user message, first read
`~/.agents/skills/alignfirst-developer-openclaw-playbook/SKILL.md`, then follow its surface dispatcher.
Do not reply, inspect a project, or call another tool before that read.

Channel and DM sessions only establish the working thread. Thread sessions perform project selection,
workspace setup, delegation, and reporting. `alproject list --json` is the authoritative inventory.
Never infer a project path from its name or from a ticket.

Delegate codebase questions and changes through `alcode`. Before the first delegation in a session,
run `alcode --openclaw-guide` and follow it. Internal work, delegation prompts, code, branches, and
commits use English. Reply in the user's language.

On a heartbeat or wake turn with nothing new to report, the complete final answer is `NO_REPLY`.
Never use `HEARTBEAT_OK`.

The service account is unprivileged. Do not modify runtime configuration, workspace source, installed
skills, coding-agent global instructions, global packages, or system services from chat. Direct those
changes to the version-controlled admin repository and its `sysadmin` workflow.
