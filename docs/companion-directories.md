---
title: Companion Directories
summary: How `alignfirst` and `aligndev` keep a project's AlignFirst files outside its repository: the companion registry and its per-project directories, matching, resolution, the `config --json` contract and the commands that read it.
read_when:
  - changing how either CLI locates `.alignfirst.json`, `.alignfirst-instructions`, `DEVELOPERS.md`, `docs`, `.plans` or `_aligndev`
  - changing the `alignfirst config --json` report or its parser in `aligndev`
  - debugging a project that reads the wrong `.plans`, docs or project config
  - adapting the playbook or the setup guide to projects without the workspace system
---

# Companion Directories

A **companion directory** holds a project's AlignFirst files outside its repository, and reproduces the project's layout for those files only. User-facing references:

- [`alignfirst` README](../packages/alignfirst/README.md#companion-directories) — the feature summary and the agent prompt.
- [aligndev Architecture](aligndev-architecture.md) — session files, `--add-dir` and the project inventory.
- [`companion-setup.md`](../skills/alignfirst-setup-guide/references/companion-setup.md) — preparing a project through its companion.

## Goal

Two cases drive the feature:

- A team uses AlignFirst and keeps `.plans/` in its repository, but `aligndev`'s session files (`_aligndev/`) must live elsewhere.
- A team does not use AlignFirst. `.alignfirst.json`, `.plans/`, `docs/`, `DEVELOPERS.md` and the project instructions come from outside the repository, which stays untouched.

## The registry

The companion registry, `~/.alignfirst/companions/registry.json`, has a fixed path, with no environment variable. It sits in the companions directory, beside the companions. `~/.alignfirst/` is the home of both CLIs: it also holds `aligndev.settings.json`, the `aligndev` settings. The registry holds companion directories and independent project profile selections. An absent registry means neither is selected.

```json
{
  "projects": {
    "~/projects/team-app": {
      "dir": "projects_team-app",
      "items": { ".plans": "project", "_aligndev": "companion" }
    },
    "~/projects/client-api": { "aligndev": { "profile": "claude-work" } }
  }
}
```

- `projects` — keys are the main worktree paths of projects, absolute or `~/`.
- `dir` — optional: the companion directory. A relative value joins the real path of `~/.alignfirst/companions`, so a symlink there moves those companions and the registry elsewhere. A `~/` value resolves against the real home directory, and an absolute one is used as written. `~` alone or `~x` is invalid.
- `aligndev` — optional `{ "profile": "<name>" }`, independent of the companion. AlignFirst validates a nonblank selection; AlignDev owns named-profile validation against its settings.
- `items` — optional, requires `dir`: settings for the six **items**: `.alignfirst.json`, `.alignfirst-instructions`, `DEVELOPERS.md`, `docs`, `.plans`, `_aligndev`. A setting is `"companion"`, `"project"` or `"auto"`; `_aligndev` takes `"companion"` or `"auto"`.

Each entry requires `dir`, `aligndev`, or both. A profile-only entry leaves every item in the project and creates no companion or separate session tree. Edit the registry by hand to select or remove a profile; report reads create no files.

Unknown or obsolete settings properties are ignored with `console.warn` on stderr. This applies to the registry root, each project entry, `items` and `aligndev`, and to `.alignfirst.json` and its recognized nested objects. Warnings identify the setting without printing its value; registry warnings redact dynamic project-path keys. Project paths under `projects` are map keys, and the six supported item names are recognized settings. Reads leave both files unchanged, and `config --json` keeps stdout as JSON containing only recognized settings. Companion registration and removal update the raw registry, preserving unknown and obsolete properties in the registry root, unrelated entries and surviving settings. Removing a companion still removes its `dir/items`; a surviving profile entry retains its extra properties.

The obsolete registry `paths` property is ignored with a manual-conversion hint pointing to the setup guide's upgrade reference. It does not select companions. `root` is also ignored; use a symlink at `~/.alignfirst/companions` or a per-project `dir`. The current `projects` object is still required, so a file containing only `paths` warns and then fails validation. In `.alignfirst.json`, `ticketPattern` is ignored with a hint to use `ticketIdPattern`; the explicitly supported deprecated `plans.folder` alias still maps to `plans.repositoryFolder`.

Recognized values, required structure and semantic constraints still undergo validation. An unreadable, malformed or invalid registry is a `CliError` naming the file, raised by every command that resolves the layout. `config` exits 1 with it; `doctor` reports it.

## Matching

A project is identified by its **main worktree path**: the parent of `git rev-parse --path-format=absolute --git-common-dir`, as a real path. Every linked worktree therefore shares its companion and profile selection. A profile-only entry keeps file locations relative to each worktree's working directory. A bare repository or a directory outside git has none.

A key matches when it equals the main worktree path. Keys are compared by real path when they exist, after `resolve` otherwise. An item the entry does not set is `"auto"`. A key that names no git main worktree, such as a parent directory or a deleted repository, matches nothing; `doctor` warns about it.

Two keys share a companion only when their `dir` values resolve to the same path, compared by real path when it exists. `companion register` refuses such a `dir` and a nested one, `alignfirst doctor` warns about shared and nested directories, and `aligndev project doctor` reports a shared one on both projects.

## Resolution

With a companion, every item except `_aligndev` resolves as follows. Without one, every item resolves to its project copy, relative to the working directory.

| Setting | Location |
| --- | --- |
| `"companion"` | The companion copy, present or not. |
| `"project"` | The project copy, present or not. |
| `"auto"` | The companion copy when it exists, else the project copy when it exists, else the companion copy as the creation target. |

`_aligndev` names the `.plans`-shaped directory under which `aligndev` writes `_aligndev/` and `<ticket>/_aligndev/`. With `"companion"`, it is `<companion>/.plans`; with `"auto"`, it is the resolved `.plans`.

A `_aligndev` location other than the resolved `.plans` is a **separate session tree**, with its own `_archives/`. `plans archive`, `plans auto-archive` and `sync` archive it by the `.plans` rules, and `ticket <id>` restores its archived `<id>/`. No move crosses from one tree to the other.

An effective `"_aligndev": "companion"` with an effective `".plans": "auto"` is an error naming the key. Without it, the first `aligndev` session would create `<companion>/.plans/`, and `alignfirst` would silently switch its work files to it.

Reads never create the companion directory. A command that creates an item there, such as `plans setup` or a new session file, creates the missing parents. Existence checks use `lstat`, so a broken `.plans` symlink still resolves in place.

## Ownership and contract

`alignfirst` owns parsing and resolution in `packages/alignfirst/src/project-layout.ts`. `resolveProjectLayout(cwd, home)` runs once per command and is cached on `ctx.layout` (`layoutOf(ctx)`). Every command reads `.alignfirst.json`, `.plans` and `docs` through it.

`aligndev` never reads the registry. `packages/aligndev/src/project/layout.ts` runs `alignfirst config --json` in a directory and parses the report:

```ts
interface ConfigReport {
  source: "project" | "companion" | null; // where .alignfirst.json was read
  cli: CliReport | null;
  config: ProjectConfig | null;
  aligndev: { profile: string } | null; // independent project selection
  companion: {
    dir: string; // resolved
    exists: boolean;
    key: string;
    items: Record<ItemName, ItemSetting | AligndevSetting>; // effective settings
  } | null;
  locations: Record<ItemName, { path: string; in: "project" | "companion"; exists: boolean }>;
}
```

AlignDev requires the profile-aware report with a top-level `aligndev` field, including when null. It detects this field rather than checking a package version, so unreleased checkout builds work. An older contract produces an upgrade error. When `alignfirst` is missing or its report is outdated or invalid, aligndev appends a one-line diagnostic with the command and why it chose that form, the resolved executable for direct launches, the available AlignFirst version, and its own version and entry path. Successful reports trigger no diagnostic work.

Paths are absolute. `config` is the validated config, with the deprecated `plans.folder` reported as `plans.repositoryFolder`. The AlignDev parser retains the `plans.folder` fallback for compatible reports using that older spelling. `key` is the registry key as written; `aligndev` ignores `key` and `items`.

## Consumers

### `alignfirst`

- **`ticket`**: `TICKET_DIR` and every reported path are relative to the working directory when inside it, absolute otherwise (`displayPath` in `format.ts`). The guides append FILE_NAME to TICKET_DIR exactly as printed.
- **Work-files mode**: `resolvePlansMode` takes the resolved `.plans`. A `.plans` inside another repository than the project's is shared with it. A real directory outside git is local mode. A symlink pointing outside git stays an error. `sync` and archival operate on the resolved `.plans`, and on a separate session tree.
- **`plans setup`**: creates the link at the resolved `.plans` location, with a target relative to the link's parent directory.
- **`docmap`**: adds `--root <companion docs>` when `docs` resolves in the companion and the arguments carry no `--root`.
- **`context`**: prints the conventions, then `context.md` from the resolved `.alignfirst-instructions` under `# Project Instructions`, then the docmap section when `docs` exists, then the protocols. The conventions give a companion `.plans` by absolute path and exclude `.plans` from searches only when it resolves in the project.
- **`config`**: the report above; the text form adds an independent `AlignDev profile:` line, a `Companion:` line, a `Companion items:` line with the settings other than `"auto"` (or `all auto`), and one line per item.
- **`companion register`**: registers the main worktree path, as a `~/` key inside the home directory and an absolute one outside it, with `{ "dir": <value> }`. The value is `--dir` as written, relative values resolving against the companions directory, never the working directory. Without `--dir`, it is a name derived from the path: the main worktree path relative to the real home directory, or the absolute path without its leading `/` outside it (the home directory itself included), with every `/` replaced by `_`. The resolved directory is refused when it is or contains the companions directory or the home directory, or when it is, contains or is inside the project or another key's companion directory. A profile-only entry gains `dir` while retaining its original key and selection. An entry with a companion leaves the registry unchanged; a `--dir` that resolves elsewhere than its `dir` is an error. The command creates the registry when missing. `--create-dir` creates a missing companion directory, marked `(created)`; without it, a missing one is marked `(missing)`. Item settings are edited by hand.
- **`companion unregister`**: removes `dir/items` and keeps the companion directory, reported as orphaned. It preserves `aligndev` and reports the remaining profile-only entry; it deletes the key only when no selection remains. A project without a companion is an error. Remove a remaining selection through a separate registry edit. `--remove-dir` also removes a directory inside the companions directory when it is empty or missing; a non-empty one requires `--force`. A directory outside it stays, and the output asks to remove it by hand. A directory that is or contains the companions directory, or one inside it that fails the bounds of `companion register`, is refused. A refusal changes nothing. Symlinks inside are removed as links.
- **`doctor`**: an independent `AlignDev` section reports the profile selection, including without a companion. A `Companion` section shows the registry state, the project's key, the resolved directory, and one line per item with its setting and location. A key that names no git main worktree, keys that share a companion directory, a companion directory inside another, and an item set to `"companion"` with a missing companion copy are warnings.

### `aligndev code`

- **Session tree**: `new`, `resume` and `status` read the report first. Session files go under `locations._aligndev.path`. New/resumed launches require usable effective plans with no files tracked by the project's own repository before ticket/session effects. A separate work-files repository is supported; an unused tracked project copy does not block a selected companion. Historical status stays readable.
- **Active tickets**: the registry lists `_aligndev/` and every `<ticket>/_aligndev/` of the session tree, `_archives/` excluded. A ticketed `new` runs `alignfirst ticket <id> --json` first, as a developer would.
- **Write access**: `createMissingCompanion` prepares a missing companion before launch, independently of the profile's `skipPermissions` or the selected child. In normal permission mode, Claude Code receives `--add-dir <companion>` after its permission flags; Codex receives it among the `exec` options, before `resume`. Pi uses ordinary OS access, receives no `--add-dir`, and honors saved project trust without forced approval.
- **Project context**: on a `new` session, when `.alignfirst.json`, `.alignfirst-instructions`, `docs` or `.plans` exists in the companion, the prompt opens with the `alignfirst context` output under `## Project context`. A resumed session gets none.
- **Asynchronous Pi callers**: the generic `background` tool only honors the command and cwd. The CLI still resolves companions and session paths. From the original worktree, `code status --meta <unique-run-key> --result` resolves a run; retain its `sessionFile:` path (relative to that worktree when inside it, absolute otherwise) and use that exact path thereafter. The job handle, unique run key and child conversation ID remain separate identities.

### `aligndev worktree`

Lightweight add reads the main worktree's report, then verifies the finished worktree's effective location. Companion plans are used directly without a generated worktree `.plans` link or local exclusion. Project-local untracked shared plans use a symlink and local Git exclusions; this does not change companion resolution. An independently selected `_aligndev` tree stays independent.

Missing effective plans, including a registered companion without `.plans`, block add before branch/worktree creation. The CLI never registers or provisions a companion. The playbook's `aligndev guide work-files-setup` obtains approval, registers when needed, explicitly selects only that entry's `.plans` as `companion`, then creates and verifies the selected directory. The selection applies to all worktrees; existing project files remain untouched and unused, without copying. Broken links, invalid configuration and conflicting files remain errors.

These are AlignDev gates. Standalone AlignFirst still supports tracked project plans and its existing local-mode `sync` behavior.

### `aligndev guide`

Under `codingAgent`, a playbook topic reads the report in the main worktree of the working directory. `locations["DEVELOPERS.md"].exists` selects the `DEVELOPERS.md` variant of the playbook. Otherwise a `README.md` at the root of that main worktree selects the README variant. A report error fails the command.

### `aligndev project`

A direct child whose `.git` is a directory is a project, unless it holds another project's resolved `.plans`, as a work-files clone does: it is then listed with the others. A child without `.git` but with a root `.alignfirst.json` is the issue "not a git main worktree". `list --json` and `status` carry each project's `aligndev`, `companion` and `locations`. Text inventory reports the selection too, without requiring a launchable coding agent. Two projects with the same companion directory is an issue on both.

### The playbook

DEVELOPERS_PATH is the project's guide file for the assistant. Under OpenClaw, each procedure retains the `DEVELOPERS.md` path from `aligndev project status <PROJECT_PATH>`. A coding-agent assistant retains `locations["DEVELOPERS.md"].path` from `alignfirst config --json` when that file exists, else `README.md` at the root of the main worktree; with neither, its playbook has no DEVELOPERS_PATH. Project rules for a companion-backed project go into its companion `.alignfirst-instructions/context.md` or `DEVELOPERS.md`, edited in place, with no branch or pull request.

Both platforms use the project's documented workspace tooling when present, including non-Node implementations. Otherwise the assistant directly creates or reuses lightweight worktrees through `aligndev worktree`, then delegates from the selected path. Explicit in-place choices and matching-ticket reuse remain valid. Work-files preparation runs before ticket reservation, request capture, coding delegation or discussion recording; it requires only the project path. Explicit companion-only onboarding registers and selects companion plans under its own authorization, even when project plans are already usable. It verifies companion destinations before writing and preserves existing work files without copying. Full workspace installation is optional.

## Bootstrap

An agent reads a repository's `AGENTS.md` on its own, never a companion. `aligndev code` puts the context into the launched agent's prompt. A human developer adds one line to their global agent instructions, given in the [`alignfirst` README](../packages/alignfirst/README.md#set-up-a-project-manually), so their agent runs `alignfirst context` in any git repository.

## Rejected alternatives

- **Matching by git remote**, from the earlier overlay design: forks, mirrors and renamed remotes break it, and a wrong match silently serves another project's conventions.
- **Keys for parent directories**, matching every project below them: projects nobody registered got a companion, and no project could be unregistered alone. They existed while AlignDev for OpenClaw locked the registry; `companion register` replaced them.
- **A per-file project-then-companion fallback without settings**: the first `aligndev` session file would create a companion `.plans` and switch `alignfirst` to it unannounced.
- **A `.plans` symlink as companion access**: it leaves a footprint in the repository and needs one link per worktree. Companions resolve directly. Lightweight worktrees may still share project-local plans through locally excluded links.
- **A coding-agent session hook to load the context**: it ties the bootstrap to one agent.
- **A configurable companions root**: a symlink at `~/.alignfirst/companions` moves every companion, and a per-project `dir` places one anywhere.
- **A companion name derived from the project path**, the shape before `dir`: two paths could collide through a `_`, and a moved project required renaming its companion.
- **The registry at `~/.alignfirst/companions.json`**, outside the companions directory: a symlink did not move it with the companions, and an AlignDev OpenClaw host had to lock it with the CLI config, so the assistant could not register a project.
- **XDG directories** (`~/.config/alignfirst/` for the files, `~/.local/share/` for the companions): the companions are hard to find, and work files would land in dotfiles repositories that track `~/.config`.

## Out of scope

- `alignfirst workspace`, a default workspace implementation.
- Moving a project: the pairing follows the path, so a moved project needs its registry key edited by hand. Its `dir` and companion stay.
