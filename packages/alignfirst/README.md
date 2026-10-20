# alignfirst

The AlignFirst CLI provides collaborative software-development workflows, work files, and documentation discovery. Work files are organized by ticket and kept either git-ignored in the project or synchronized through a work-files repository.

See the [product page](https://alignfirst.paroi.tech/skills) for a demonstration.

Supported systems: Linux and macOS, and Windows through WSL.

## Agent skills

Nine Agent Skill stubs expose the CLI as commands in Claude Code, Codex, GitHub Copilot, and Cursor. Install them globally:

```sh
npx skills add https://github.com/paleo/alignfirst --global \
  --skill alspec --skill alplan --skill al --skill almerge \
  --skill alreview --skill aldescription --skill alcatchup \
  --skill alcatchupaad --skill alcatchupspec
```

Install the `alignfirst` skill when a project's `AGENTS.md` does not run `npx alignfirst context`; it lets the agent recognize a protocol named in prose:

```sh
npx skills add https://github.com/paleo/alignfirst --global --skill alignfirst
```

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
| Catch up | `/alcatchup` | Load the current ticket history and continue. |
| Catch up and AAD | `/alcatchupaad <request>` | Load ticket history, then start AAD. |
| Catch up and spec | `/alcatchupspec <request>` | Load ticket history, then start specification. |

To implement a plan, start a fresh agent context and ask it to execute the plan file.

AlignFirst stores the work files of a ticket, such as specifications, plans and summaries, in `.plans/<ticket-id>/`. It normally derives the ticket ID from the request or branch and asks when none is available. Files use a cycle letter and sequence number, such as `A1-spec.md` and `A2-plan.md`.

## Set up a project (with your agent)

Install the alignfirst-setup-guide skill:

```sh
npx skills add https://github.com/paleo/alignfirst --global --skill alignfirst-setup-guide
```

Then ask your agent:

```text
Use your alignfirst-setup-guide skill. What AlignFirst tooling could we add in this project?
```

The guide installs the selected components and configures the repository. You can remove the setup-guide skill once setup is complete.

## Set up a project manually

1. Create `.plans/` and ignore it:

   ```sh
   mkdir .plans
   echo .plans >> .gitignore
   ```

2. Load the project context. Add this section to the project's `AGENTS.md`, as its first `##` section:

   ```markdown
   ## Start every session with the project context

   Run `npx -y alignfirst context` from the repository root as your first command, whatever the task. It prints the project conventions (ticket IDs, branch names, commits), the documentation map, and the AlignFirst protocols.

   ### Conventions

   - Ticket IDs: `^[A-Z]+-\d+$`, such as `ABC-123`.
   - Branch names: `{TICKET_ID}/{slug-1-3-words}`.
   - Commits: `type: [TICKET_ID] summary`.
   ```

   `.alignfirst.json` is optional ([schema](https://github.com/paleo/alignfirst/blob/main/skills/alignfirst-setup-guide/references/alignfirst-skills-setup.md#with-alignfirstjson)). With it, `alignfirst context` prints the conventions, so omit the `### Conventions` sub-section.

## CLI commands

- `guide` — Print an AlignFirst protocol.
- `ticket` — Resolve a ticket directory, load its history (`--catchup`, plans excluded), or get its next file.
- `sync` — Synchronize the work files with the work-files repository.
- `plans` — Link `.plans` to the work-files repository, check the link, archive tickets.
- `docmap` — Browse project documentation.
- `conventions` — Print the effective project conventions.
- `context` — Print the conventions, the project instructions from `.alignfirst-instructions/context.md`, the documentation map when `docs/` exists, and the protocol aliases.
- `companion register` — Register the current project in the companion registry. `--dir` sets its companion directory; `--create-dir` also creates it.
- `companion unregister` — Remove the current project from the companion registry. `--remove-dir` also removes its companion directory.
- `config` — Report the effective project configuration, the companion directory and the location of each AlignFirst file.
- `doctor` — Diagnose an AlignFirst setup.

Run `alignfirst --help` for command usage or `alignfirst guide` to choose a protocol. `alignfirst guide <protocol>` prints the selected protocol followed by the ticket directory and work file rules. Add `--protocol-only` when those rules are already in context.

## Companion directories

A companion directory holds a project's AlignFirst files (`.alignfirst.json`, `.plans`, `docs`, project instructions) outside its repository, so the repository stays untouched. Each project has its own, declared in `~/.alignfirst/companions/registry.json`.

Ensure the alignfirst-setup-guide skill is installed, then ask your agent:

```text
Use your alignfirst-setup-guide skill. Set up AlignFirst in this project without touching the repository.
```

The same registry can select a named AlignDev profile without a companion:

```json
{
  "projects": {
    "~/projects/client-api": { "aligndev": { "profile": "claude-work" } }
  }
}
```

Edit this selection by hand. A profile-only entry leaves project files in place, including in linked worktrees. `config --json` reports `aligndev` independently of `companion`; `config` and `doctor` show the selection. Named-profile resolution belongs to AlignDev's forthcoming settings contract.

`companion register` preserves a selection when adding a directory. `companion unregister` removes companion fields and preserves the selection; remove the remaining profile-only entry through a separate registry edit.

### Loading the AlignFirst context

If you can't edit the project's `AGENTS.md` file, add this section to your global agent instructions (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, or the equivalent), with the project's path:

```markdown
## AlignFirst - Start every session with the project context

When you work on the project `/path/to/a/project`, run `npx -y alignfirst context` as your first command, whatever the task.
```

### Global skill diagnostics

`alignfirst doctor` checks global skills in shared, Claude Code, Codex, then Pi roots. Pi defaults to `~/.pi/agent/skills`; `PI_CODING_AGENT_DIR` replaces that Pi root with `<agent-dir>/skills`. Relative paths resolve from the command's working directory. This check excludes project resources, package filters and trust decisions.

## Upgrade from v1, v2, or v3

Install the setup-guide skill and ask your agent to run its upgrade route:

```sh
npx skills add https://github.com/paleo/alignfirst --global --skill alignfirst-setup-guide
```

```text
Use your alignfirst-setup-guide skill. Upgrade AlignFirst in this project.
```

You can remove the setup-guide skill once the upgrade is complete.

## License

CC0 1.0 Universal.
