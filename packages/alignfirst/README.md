# alignfirst

The AlignFirst CLI provides collaborative software-development workflows, work files, and documentation discovery. Work files are organized by ticket and kept either git-ignored in the project or synchronized through a work-files repository.

See the [product page](https://alignfirst.paroi.tech/skills) for a demonstration.

Supported systems: Linux and macOS, and Windows through WSL.

## Agent skills

Nine Agent Skill stubs expose the CLI as commands in Claude Code, Codex, GitHub Copilot, and Cursor. Install them globally:

```sh
npx skills add https://github.com/paleo/alignfirst --global \
  --skill al --skill alplan --skill alspec --skill aldescription \
  --skill alreview --skill alcatchup --skill almerge \
  --skill alcatchupaad --skill alcatchupspec
```

Install the `alignfirst` skill when a project's `AGENTS.md` does not run `npx alignfirst context`; it lets the agent recognize a protocol named in prose:

```sh
npx skills add https://github.com/paleo/alignfirst --global --skill alignfirst
```

The skills run the CLI through `npx`, so installing it is optional.

### Update the agent skills

```sh
npx skills update --global
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

## Global CLI

To type `alignfirst` instead of `npx alignfirst`, install the CLI globally:

```sh
npm install -g alignfirst
```

### Update the global CLI

```sh
npm update -g alignfirst
```

## Set up a project (with your agent)

Temporarily install the setup-guide skill:

```sh
npx skills add https://github.com/paleo/alignfirst --global --skill alignfirst-setup-guide
```

Then ask your agent:

```text
Use your alignfirst-setup-guide skill. What AlignFirst tooling could we add in this project?
```

The guide installs the selected components and configures the repository. You can remove the setup-guide skill once setup is complete.

To leave the repository untouched, the guide keeps the project's AlignFirst files in a [companion directory](#companion-directories):

```text
Use your alignfirst-setup-guide skill. Set up AlignFirst in this project without touching the repository.
```

## CLI commands

- `guide` — Print an AlignFirst protocol.
- `ticket` — Resolve a ticket directory, load its history, or get its next file.
- `sync` — Synchronize the work files with the work-files repository.
- `plans` — Link `.plans` to the work-files repository, check the link, archive tickets.
- `docmap` — Browse project documentation.
- `conventions` — Print the effective project conventions.
- `context` — Print the conventions, the project instructions from `.alignfirst.md`, the documentation map when `docs/` exists, and the protocol aliases.
- `companion add` — Register the current project in the companion registry and create its companion directory.
- `config` — Report the effective project configuration, the companion directory and the location of each AlignFirst file.
- `doctor` — Diagnose an AlignFirst setup.

Run `alignfirst --help` for command usage or `alignfirst guide` to choose a protocol. `alignfirst guide <protocol>` prints the selected protocol followed by the ticket directory and work file rules. Add `--protocol-only` when those rules are already in context.

### Catchup output

`alignfirst ticket [<id>] --catchup` prints the ticket's Markdown files, plans excluded.

## Companion directories

A companion directory holds a project's AlignFirst files outside its repository, so the repository stays untouched. The companion registry, `~/.alignfirst/companions/registry.json`, declares which projects have one:

```json
{
  "paths": {
    "~/projects/team-app": { ".plans": false, "_aligndev": true },
    "~/projects/client-api": {},
    "~/projects": {}
  }
}
```

- `paths` — the projects, by absolute or `~/` path. Each value sets flags for the items a companion can hold: `.alignfirst.json`, `.alignfirst.md`, `DEVELOPERS.md`, `docs`, `.plans` and `_aligndev`. A flag is `true`, `false` or `"auto"`.

An absent registry means no project has a companion. An invalid registry makes every command fail; `doctor` reports it and continues.

Run `alignfirst companion add` in a project to register it. It adds the project's main worktree path with every item on `"auto"`, unless a key already matches it, and creates the companion directory. Set the flags by editing the registry.

### Matching

A key matches a project when it names the project's main worktree or one of its ancestors, so every worktree of a project shares one companion. `"~": {}` matches every project under the home directory. For each item, the longest matching key that sets the flag wins, and an unset flag is `"auto"`. A bare repository or a directory outside git has no companion.

The companion directory is `~/.alignfirst/companions/<name>`. The name is the main worktree path relative to the home directory, or the absolute path without its leading `/` outside it, with every `/` replaced by `_`. For example, `~/projects/client-api` gets `~/.alignfirst/companions/projects_client-api/`. To keep the companions and their registry elsewhere, make `~/.alignfirst/companions` a symlink.

### Resolution

| Flag | Location |
| --- | --- |
| `true` | The companion copy, present or not. |
| `false` | The project copy, present or not. |
| `"auto"` | The companion copy when it exists, otherwise the project copy when it exists, otherwise the companion copy, where the item gets created. |

`_aligndev` is the directory under which `aligndev` writes its session files: `<companion>/.plans` when `true`, the resolved `.plans` otherwise. `"_aligndev": true` requires `.plans` set to `true` or `false`. When the two differ, archiving and `ticket <id>` apply to both trees, each with its own `_archives/`.

`alignfirst config` reports the companion and the location of every item. `alignfirst doctor` checks them.

### Project instructions

`.alignfirst.md` holds free prose for the coding agent: the project instructions a prepared project keeps in its `AGENTS.md`. `alignfirst context` prints it under `# Project Instructions`. It resolves like the other items, so a project copy works too.

### Agent bootstrap

An agent reads a repository's `AGENTS.md` on its own, but never a companion. When your repositories carry no AlignFirst instructions, add this line to your global agent instructions (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, or the equivalent):

```text
In a git repository, run `alignfirst context` as your first command, whatever the task, unless the project's instructions already say so.
```

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
