# alignfirst

The AlignFirst CLI provides collaborative software-development workflows, work files, and documentation discovery. Work files are organized by ticket and kept either git-ignored in the project or synchronized through a work-files repository.

See the [product page](https://alignfirst.paroi.tech/skills) for a demonstration.

Supported systems: Linux and macOS, and Windows through WSL.

## Agent skills

Nine Agent Skill stubs expose the CLI as commands in Claude Code, Codex, Pi, Antigravity, GitHub Copilot, and Cursor. They run with Node.js or Bun. Install them globally:

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

## Protocols

These examples use the `/` form. Replace it with `$` in Codex, or with `/skill:` in Pi (for example `/skill:alspec`).

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

Ask your agent:

```text
Run `npx -y alignfirst setup`. What AlignFirst tooling could we add in this project?
```

The guide installs the selected components and configures the repository.

## Set up a project manually

1. From the main-worktree root, run `setup init` with the project's conventions:

   ```sh
   npx -y alignfirst setup init \
     --ticket-pattern '^[A-Z]+-\d+$' \
     --default-branch main \
     --branch-template '{TICKET_ID}/{slug-1-3-words}' \
     --commit-style conventionalCommit \
     --commit-ticket-reference bracketed
   ```

   It writes `alignfirst.json` ([format](https://github.com/paleo/alignfirst/blob/main/packages/alignfirst/templates/setup/topics/configuration.md)), creates `.plans/` and ignores it, and adds the bootstrap section to `AGENTS.md`. `npx -y alignfirst setup init --help` lists the flags.

2. Check the bootstrap section. `npx -y alignfirst setup instructions` reports its status and prints the canonical text.

Without `alignfirst.json`, a `### Conventions` sub-section under the bootstrap section of `AGENTS.md` remains supported.

## CLI commands

- `guide` — Print an AlignFirst protocol.
- `ticket` — Resolve a ticket directory, load its history (`--catchup`, plans excluded), or get its next file.
- `sync` — Synchronize the work files with the work-files repository.
- `plans` — Link `.plans` to the work-files repository, check the effective work files (`plans check`, with `--json` for a machine-readable report), or archive tickets.
- `docmap` — Browse project documentation.
- `conventions` — Print the effective project conventions.
- `context` — Print project conventions, the documentation map and protocol aliases.
- `setup` — Report the project's AlignFirst state and print the setup guide. `setup guide <topic>` prints a topic, `setup init` adopts the protocols, `setup instructions` checks or writes the bootstrap section.
- `companion register` — Register the current project in the companion registry. `--dir` sets its companion directory; `--create-dir` also creates it. `--default-location` sets the registration's default location; `--item <name>=<location>` sets one item and is repeatable.
- `companion unregister` — Remove the current project from the companion registry. `--remove-dir` also removes its companion directory.
- `config` — Report the effective project configuration, the companion directory and the location of each AlignFirst file.
- `assistant-instructions` — Print project guidance and the project's assistant guide.
- `doctor` — Diagnose an AlignFirst setup.
- `workspace` — Create/adopt, list, inspect, wait for, teardown, remove or prune workspaces. `workspace --guide` describes effective capabilities.
- `dev` — Prepare declared ports/run files/infrastructure and start, stop or inspect managed services.

Run `alignfirst --help` for command usage or `alignfirst guide` to choose a protocol. `alignfirst guide <protocol>` prints the selected protocol followed by the ticket directory and work file rules. Add `--protocol-only` when those rules are already in context.

## Multi-stack workspaces and configuration

Use `npx -y alignfirst workspace` or `bunx --bun alignfirst workspace` for Node, Python and other stacks. No project wrapper or local dependency is needed. Prepare usable effective plans and selected runtime storage before setup. Local runtime requires ignored/untracked `.local-wt/`; companion runtime creates no checkout runtime directories or links. Without a manifest, readiness is protocol-ready; no install/build, ports or services are implied.

One selected `alignfirst.json`/`.jsonc` holds `schemaVersion: 1`, optional URI-valued `$schema`, nested `conventions`, `plans`, the deprecated `assistantInstructionsFile`, `workspace` and `devServer`. JSON is strict; JSONC permits comments/trailing commas. Ambiguity, unknown properties and unsupported schemas fail without fallback. One complete editor schema ships with AlignFirst; future breaking majors require retained in-memory converters through the CLI major. Reads never rewrite committed configuration.

`config --json` returns the full configuration with canonical field names, logical locations, selection origins and workspace metadata including absolute `registryDir`/`runtimeDir`. `config --json <dir>...` prints `{ "reports": [...] }`, one `{ path, report }` or `{ path, error }` entry per directory, in the order given. It evaluates neither scripts nor environment bindings. Keep credentials in environment variables or ignored files; authored literals may appear in reports/logs. Companion selection chooses the entire configuration without section merging. Port ranges belong only in `devServer.ports`.

`context` and `assistant-instructions` include workspace guidance. A declared `workspace` or `devServer` selects configured-workspace guidance; otherwise they show a workspace-guide pointer. Development-server commands appear only when `devServer` is declared.

`context` places this guidance after optional project instructions and before Docmap. Embedded Docmap asks readers to read task-relevant documents and omits the bare invocation example.

`assistant-instructions` prints guidance, then the assistant guide in an `<assistant-instructions scope="project">` block with its absolute path. The guide is the optional `ASSISTANTS.md`. A missing or blank guide prints guidance alone. An unreadable guide fails before any output. So does a guide path that a symbolic link leads out of its project or companion root, even before the file exists; other commands ignore that link. It does not load coding-agent context, Docmap or protocols.

The configuration property `assistantInstructionsFile` and its older alias `developerInstructions` are deprecated. They still name a guide under another name, and reads warn on stderr. `alignfirst setup guide upgrade` describes the rename. The companion registry item keeps its `developerInstructions` alias, with a warning. Reads expose `assistantInstructionsFile` without rewriting either file; a defined `assistantInstructionsFile` takes precedence, including when invalid. The legacy `developer-instructions` command prints the same output as `assistant-instructions` and warns.

External owners adopt through setup and run teardown before their own deletion. Failed cleanup retains identity for retry. See [workspace setup](https://github.com/paleo/alignfirst/blob/main/packages/alignfirst/templates/setup/topics/workspace.md) and [the clean-break upgrade runbook](https://github.com/paleo/alignfirst/blob/main/docs/upgrading-multi-stack-workspaces.md) before converting old wrappers/settings/state.

## Companion directories

A companion directory holds a project's AlignFirst files (`alignfirst.json`/`.jsonc`, `.plans`, `docs`, project instructions) outside its repository. Protocols and Docmap can leave repository files untouched; runtime can also live externally. `defaultLocation` supplies per-registration placement below explicit item settings. Logical `assistantInstructionsFile` selects the root of the assistant guide; `workspaceRuntime` uses companion storage only when effectively companion, while project/auto stays local. Ordinary auto selects existing companion files, then project files, then the companion destination. Commands, generated application files and shared directories may still write project files. Each project has its own, declared in `~/.alignfirst/companions/registry.json`.

Ask your agent:

```text
Run `npx -y alignfirst setup`. Use a companion directory, no footprint please.
```

The same registry can select a named AlignDev profile without a companion:

```json
{
  "projects": {
    "~/projects/client-api": { "aligndev": { "profile": "claude-work" } }
  }
}
```

Edit this selection by hand. A profile-only entry leaves project files in place, including in linked worktrees. `config --json` reports `aligndev` independently of `companion`; `config` and `doctor` show the selection. Named-profile resolution belongs to AlignDev's settings contract.

`companion register` preserves a selection when adding a directory. `companion unregister` removes companion fields and preserves the selection; remove the remaining profile-only entry through a separate registry edit.

### Loading the AlignFirst context

If you can't edit the project's `AGENTS.md` file, add an AlignFirst section to your global agent instructions (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, or the equivalent). When the project's companion registration has `defaultLocation: "companion"`, `npx -y alignfirst setup instructions` prints that section with the project's path.

### Global skill diagnostics

`alignfirst doctor` checks global skills in shared, Claude Code, Codex, then Pi roots. Pi defaults to `~/.pi/agent/skills`; `PI_CODING_AGENT_DIR` replaces that Pi root with `<agent-dir>/skills`. Relative paths resolve from the command's working directory. It reports the `aligndev` skill at info level without expecting it. This check excludes project resources, package filters and trust decisions.

## Upgrade from v1, v2, or v3

Ask your agent:

```text
Run `npx -y alignfirst setup`. Upgrade AlignFirst in this project.
```

## License

CC0 1.0 Universal.
