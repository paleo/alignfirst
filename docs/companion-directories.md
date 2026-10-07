---
title: Companion Directories
summary: How `alignfirst` and `aligndev` keep a project's AlignFirst files outside its repository: `companions.json`, matching, resolution, the `config --json` contract and the commands that read it.
read_when:
  - changing how either CLI locates `.alignfirst.json`, `.alignfirst.md`, `DEVELOPERS.md`, `docs`, `.plans` or `_aligndev`
  - changing the `alignfirst config --json` report or its parser in `aligndev`
  - debugging a project that reads the wrong `.plans`, docs or project config
  - adapting the playbook or the setup guide to projects without the workspace system
---

# Companion Directories

A **companion directory** holds a project's AlignFirst files outside its repository, and reproduces the project's layout for those files only. User-facing references:

- [`alignfirst` README](../packages/alignfirst/README.md#companion-directories) — the file, matching, resolution and the agent bootstrap line.
- [`aligndev` README](../packages/aligndev/README.md) — session files, `--add-dir` and the project inventory.
- [`companion-setup.md`](../skills/alignfirst-setup-guide/references/companion-setup.md) — preparing a project through its companion.

## Goal

Two cases drive the feature:

- A team uses AlignFirst and keeps `.plans/` in its repository, but `aligndev`'s session files (`_aligndev/`) must live elsewhere.
- A team does not use AlignFirst. `.alignfirst.json`, `.plans/`, `docs/`, `DEVELOPERS.md` and the project instructions come from outside the repository, which stays untouched.

## The file

`~/.alignfirst/companions.json` has a fixed path, with no environment variable. `~/.alignfirst/` is the home of both CLIs: it also holds `aligndev.config.json` and, by default, the companions. An absent file means no project has a companion.

```json
{
  "paths": {
    "~/projects/team-app": { ".plans": false, "_aligndev": true },
    "~/projects": {}
  }
}
```

- `root` — optional, the directory holding the companions: an absolute or `~/` path. It defaults to `~/.alignfirst/companions`.
- `paths` — keys are absolute or `~/` paths. Each value sets optional flags for the six **items**: `.alignfirst.json`, `.alignfirst.md`, `DEVELOPERS.md`, `docs`, `.plans`, `_aligndev`. A flag is `true`, `false` or `"auto"`.

The arktype schema rejects unknown keys at every level. An unreadable or invalid file is a `CliError` naming the file, raised by every command that resolves the layout. `config` exits 1 with it; `doctor` reports it.

## Matching and naming

A project is identified by its **main worktree path**: the parent of `git rev-parse --path-format=absolute --git-common-dir`, as a real path. Every linked worktree therefore shares one companion. A bare repository or a directory outside git has none.

A key matches when it equals the main worktree path or is an ancestor of it. Keys and the root are compared by real path when they exist, after `resolve` otherwise. For each item, the most specific matching key (the longest path) that sets the flag wins; an item no key sets is `"auto"`.

The companion is `<root>/<name>`. The name is the main worktree path relative to the real home directory, or the absolute path without its leading `/` outside it (the home directory itself included), with every `/` replaced by `_`. Two projects collide only through a `_` in a directory name. `aligndev project doctor` reports the collision on both projects.

## Resolution

With a companion, every item except `_aligndev` resolves as follows. Without one, every item resolves to its project copy, relative to the working directory.

| Flag | Location |
| --- | --- |
| `true` | The companion copy, present or not. |
| `false` | The project copy, present or not. |
| `"auto"` | The companion copy when it exists, else the project copy when it exists, else the companion copy as the creation target. |

`_aligndev` names the `.plans`-shaped directory under which `aligndev` writes `_aligndev/` and `<ticket>/_aligndev/`. With `true`, it is `<companion>/.plans`; otherwise it is the resolved `.plans`.

A `_aligndev` location other than the resolved `.plans` is a **separate session tree**, with its own `_archives/`. `plans archive`, `plans auto-archive` and `sync` archive it by the `.plans` rules, and `ticket <id>` restores its archived `<id>/`. No move crosses from one tree to the other.

An effective `"_aligndev": true` with an effective `".plans": "auto"` is an error naming the matching keys. Without it, the first `aligndev` session would create `<companion>/.plans/`, and `alignfirst` would silently switch its work files to it.

Reads never create the companion directory. A command that creates an item there, such as `plans setup` or a new session file, creates the missing parents. Existence checks use `lstat`, so a broken `.plans` symlink still resolves in place.

## Ownership and contract

`alignfirst` owns parsing and resolution in `packages/alignfirst/src/project-layout.ts`. `resolveProjectLayout(cwd, home)` runs once per command and is cached on `ctx.layout` (`layoutOf(ctx)`). Every command reads `.alignfirst.json`, `.plans` and `docs` through it.

`aligndev` never reads `companions.json`. `packages/aligndev/src/project/layout.ts` runs `alignfirst config --json` in a directory and parses the report:

```ts
interface ConfigReport {
  source: "project" | "companion" | null; // where .alignfirst.json was read
  cli: CliReport | null;
  config: ProjectConfig | null;
  companion: { dir: string; exists: boolean; entries: string[]; flags: Record<ItemName, Flag> } | null;
  locations: Record<ItemName, { path: string; in: "project" | "companion"; exists: boolean }>;
}
```

Paths are absolute. `entries` lists the matching keys as written, most specific first; `aligndev` ignores `entries` and `flags`.

## Consumers

### `alignfirst`

- **`ticket`**: `TICKET_DIR` and every reported path are relative to the working directory when inside it, absolute otherwise (`displayPath` in `format.ts`). The guides append FILE_NAME to TICKET_DIR exactly as printed.
- **Work-files mode**: `resolvePlansMode` takes the resolved `.plans`. A `.plans` inside another repository than the project's is shared with it. A real directory outside git is local mode. A symlink pointing outside git stays an error. `sync` and archival operate on the resolved `.plans`, and on a separate session tree.
- **`plans setup`**: creates the link at the resolved `.plans` location, with a target relative to the link's parent directory.
- **`docmap`**: adds `--root <companion docs>` when `docs` resolves in the companion and the arguments carry no `--root`.
- **`context`**: prints the conventions, then the resolved `.alignfirst.md` under `# Project Instructions`, then the docmap section when `docs` exists, then the protocols. The conventions give a companion `.plans` by absolute path and exclude `.plans` from searches only when it resolves in the project.
- **`config`**: the report above; the text form adds a `Companion:` line and one line per item.
- **`doctor`**: a `Companion` section with the file state, the matching keys, the directory and each item. An item flagged `true` with a missing companion copy is a warning.

### `aligndev code`

- **Session tree**: `new`, `resume` and `status` read the report first. Session files go under `locations._aligndev.path`, and the launch gate requires `locations[".plans"].exists`.
- **Active tickets**: the registry lists `_aligndev/` and every `<ticket>/_aligndev/` of the session tree, `_archives/` excluded. A ticketed `new` runs `alignfirst ticket <id> --json` first, as a developer would.
- **Write access**: when any item but `_aligndev` exists in the companion and `code.skipPermissions` is `false`, the agent receives `--add-dir <companion>`. Claude Code takes it after the permission flags. Codex takes it among the `exec` options, before `resume`.
- **Project context**: on a `new` session, when `.alignfirst.json`, `.alignfirst.md`, `docs` or `.plans` exists in the companion, the prompt opens with the `alignfirst context` output under `## Project context`. A resumed session gets none.

### `aligndev project`

A direct child whose `.git` is a directory is a project, unless it holds another project's resolved `.plans`, as a work-files clone does: it is then listed with the others. A child without `.git` but with a root `.alignfirst.json` is the issue "not a git main worktree". `list --json` and `status` carry each project's `companion` and `locations`. Two projects with the same companion directory is an issue on both.

### The playbook

Each procedure retains the `DEVELOPERS.md` path from `aligndev project status <PROJECT_PATH>` as DEVELOPERS_PATH. Project rules for a companion-backed project go into its companion `.alignfirst.md` or `DEVELOPERS.md`, edited in place, with no branch or pull request.

A project runs in **main-worktree mode** when DEVELOPERS_PATH is missing or has no workspaces section. The main worktree is its only workspace, claimed by one working thread at a time. It is free when it is clean on the default branch, or already on the thread's own branch. Branches are created and checked out there with `git switch`.

## Bootstrap

An agent reads a repository's `AGENTS.md` on its own, never a companion. `aligndev code` puts the context into the launched agent's prompt. A human developer adds one line to their global agent instructions, given in the [`alignfirst` README](../packages/alignfirst/README.md#agent-bootstrap), so their agent runs `alignfirst context` in any git repository.

## Rejected alternatives

- **Matching by git remote**, from the earlier overlay design: forks, mirrors and renamed remotes break it, and a wrong match silently serves another project's conventions.
- **A per-file project-then-companion fallback without flags**: the first `aligndev` session file would create a companion `.plans` and switch `alignfirst` to it unannounced.
- **A `.plans` symlink hidden through `.git/info/exclude`**: it leaves a footprint in the repository and needs one link per worktree.
- **A coding-agent session hook to load the context**: it ties the bootstrap to one agent.
- **XDG directories** (`~/.config/alignfirst/` for the files, `~/.local/share/` for the companions): the companions are hard to find, and work files would land in dotfiles repositories that track `~/.config`.

## Out of scope

- `alignfirst workspace`, a default workspace implementation.
- Moving a companion: the pairing follows the path, so a moved project needs its entry and its companion renamed by hand.
