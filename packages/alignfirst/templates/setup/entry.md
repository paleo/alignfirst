# Setup Guide

The project state above is the inspection: rely on it instead of probing the repository for the same facts. Read a topic with `{{CMD}} setup guide <topic>` when the user's request reaches it, and read it before making the changes it covers.

## Routes

- Protocols, project conventions or the CLI: `{{CMD}} setup guide protocols`.
- Global command skills: `{{CMD}} setup guide skills`.
- A work-files repository shared by the team: `{{CMD}} setup guide work-files`.
- A repository that must stay untouched, or AlignFirst files kept outside it: `{{CMD}} setup guide companion`.
- Documentation: `{{CMD}} setup guide docmap`.
- Workspaces and dev servers, for any stack: `{{CMD}} setup guide workspace`.
- Paseo: `{{CMD}} setup guide paseo`.
- A project an assistant will work on: `{{CMD}} setup guide assistant-project`.
- Claude Code, Codex or a persistent Pi session as the AlignDev assistant: `{{CMD}} setup guide coding-agent-assistant`.
- An OpenClaw assistant: install the `aligndev-openclaw-setup` skill with `{{SKILLS}} add https://github.com/paleo/alignfirst --global --skill aligndev-openclaw-setup --yes </dev/null`, then follow it.
- An upgrade, or any legacy signal in the report: `{{CMD}} setup guide upgrade`.

When the user names AlignDev without saying where the assistant runs, ask whether it is an OpenClaw assistant or a coding agent.

## Topics

{{TOPICS}}

## Rules

- Install or upgrade only what the user requested. Do not add unrelated tools or present the full menu.
- Protocols, skills, Docmap and workspaces are adopted independently. Global skills, Docmap or a workspace alone do not opt the repository into the protocols.
- Require a clean working tree immediately before project mutations. Read-only discovery needs none.
- Obtain the user's approval before any global installation. A recommendation implies no global installation, no live registry mutation and no edit in an external repository.
- Never suggest a global installation of the AlignFirst CLI. Use `{{CMD}}`.
- Install current stable packages and the current Node LTS. Inspect an installed package's declared runtime and peer compatibility before use.
- Honor the project's runtime and package manager. Translate application commands to the confirmed toolchain. Preserve the project's runtime requirements and the isolation between the system and the project.
- Review source and security changes before operator-controlled maintenance. An unversioned installation does not authorize unattended updates.
- A legacy signal in the report routes to its upgrade topic before any other change. Legacy package scopes and wrappers are upgrade evidence, never a reason to keep the old kernel.

## Recommend tooling

When the user asks what to adopt, base the answer on the project state and the session's available skills. Present global skills separately from project tooling; `{{CMD}} setup guide skills` describes them. Let the user choose any subset before installation.

- Recommend the protocols and Docmap whatever the language.
- Workspace isolation is language-neutral. Preserve the project's existing commands by expressing them in the workspace recipe. Without a recipe, setup is protocol-ready.
- Propose converting existing workspace tooling. Never run an incompatible old wrapper against the new registries.
- Before offering a work-files repository, establish whether the team already has one. The report shows only a linked clone.
