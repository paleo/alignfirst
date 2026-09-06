# alignfirst

The AlignFirst CLI provides collaborative software-development workflows, task files, shared plans, project conventions, documentation discovery, and setup diagnostics.

## Installation

Install it globally:

```sh
npm install -g alignfirst
```

Or run the current version without installing it:

```sh
npx alignfirst
```

## Setup with your agent

Temporarily install the setup-guide skill:

```sh
npx skills add https://github.com/paleo/alignfirst --skill alignfirst-setup-guide
```

Then ask your agent:

```text
Use your alignfirst-setup-guide skill. Set up AlignFirst in this project. Ask before installing anything globally.
```

The guide installs the selected components and configures the repository. Remove the setup-guide skill when setup is complete.

## Commands

- `guide` — Print an AlignFirst protocol.
- `ticket` — Resolve a ticket directory and its next file.
- `sync` — Synchronize shared plans.
- `plans` — Set up, check and archive plans.
- `docmap` — Browse project documentation.
- `conventions` — Print the effective project conventions.
- `context` — Print the conventions and the documentation map.
- `config` — Report the effective project configuration.
- `doctor` — Diagnose an AlignFirst setup.

Run `alignfirst --help` for command usage or `alignfirst guide` for the collaboration guide.

## Agent skills

Eight optional Agent Skill stubs expose the CLI to GitHub Copilot, Cursor, Claude Code, and Codex. The skills contain no protocols; they invoke `npx alignfirst guide`.

Install them globally:

```sh
npx skills add https://github.com/paleo/alignfirst --global \
  --skill alignfirst --skill al --skill alplan --skill alspec \
  --skill aldescription --skill alreview --skill alcatchup --skill almerge
```

Restart the agent after installation. Claude Code, GitHub Copilot, and Cursor expose skills with `/`; Codex uses `$`.

## Workflows

These examples use the `/` form. Replace it with `$` in Codex.

| Workflow | Command | Result |
| --- | --- | --- |
| Specification | `/alspec <request>` | Discuss and write a technical specification. |
| Planning | `/alplan` | Turn a specification into one or more implementation plans. |
| Align and do | `/al <request>` | Discuss and implement a small change, then write a summary. |
| Description | `/aldescription` | Summarize the work and propose a commit message. |
| Review | `/alreview` | Review the current branch against its base. |
| Merge | `/almerge` | Resolve merge or rebase conflicts. |
| Catch up | `/alcatchup` | Load the current task history and continue. |

To implement a plan, start a fresh agent context and ask it to execute the plan file.

AlignFirst stores specifications, plans, and summaries in `.plans/<ticket-id>/`. It normally derives the ticket ID from the request or branch and asks when none is available. Files use a cycle letter and sequence number, such as `A1-spec.md` and `A2-plan.md`.

## Updates

```sh
npm update -g alignfirst
npx skills update --global --yes
```

## Upgrade from v1, v2, or v3

Install the setup-guide skill and ask your agent to run its upgrade route:

```sh
npx skills add https://github.com/paleo/alignfirst --skill alignfirst-setup-guide
```

```text
Use your alignfirst-setup-guide skill. Upgrade AlignFirst in this project.
```

_Note: the setup-guide skill can be removed safely after it's done._

## License

CC0 1.0 Universal.
