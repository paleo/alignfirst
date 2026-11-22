# Companion Directory

A companion directory holds selected AlignFirst files outside the product repository, and can also hold the complete workspace recipe and runtime. With it, the protocols and Docmap leave the repository untouched.

Companion placement is not a write sandbox. Shared-directory links, application commands, generated files, dependency installation and Git operations may still write project files. Obtain the user's approval for those effects.

## Requests

| The user asks | The agent runs |
| --- | --- |
| "Use a companion directory, no footprint" | `{{CMD}} setup init --default-location companion` |
| "Use a companion directory for `alignfirst.json`" | `{{CMD}} setup init --default-location project --item alignfirst=companion` |
| "Everything in the companion except the docs" | `{{CMD}} setup init --default-location companion --item docs=project` |
| "Only the work files in the companion" | `{{CMD}} companion register --item .plans=companion` |

Add the convention flags of `{{CMD}} setup guide protocols` to `setup init`. On a project that already has its files, change the selection with `{{CMD}} companion register`, which accepts the same `--default-location` and `--item` flags.

Every item left out stays on `auto`, and under `auto` a missing item is created in the companion once one is registered. For that reason, `setup init` refuses `--item` without `--default-location`: the default location must be an explicit choice. `companion register` accepts `--item` alone; on a project whose files are not all written yet, add `--default-location project` to keep the new files in the project.

## 1. Confirm the scope

Obtain the user's authorization for the onboarding. Install global skills only when requested (`{{CMD}} setup guide skills`). Preserve the native permission policy of the coding agent. Preparing a project for an assistant follows `{{CMD}} setup guide assistant-project`, which skips the skills and the global bootstrap line.

## 2. Register and select

Run the registration from the main worktree. `--dir <path>` chooses the companion directory: by default it lies under `~/.alignfirst/companions/`, and a relative `--dir` resolves there. `--create-dir` creates it immediately; otherwise the first command that writes an item creates it.

The registry is `~/.alignfirst/companions/registry.json`, keyed by main-worktree path under `projects`. Linked worktrees share their main worktree's registration. Registration refuses unsafe overlaps. `--default-location` and `--item` apply to a new or an existing registration, and keep its directory, its other items and its profile selection.

The registration's `defaultLocation` applies to every item. An explicit item overrides it, including an explicit `auto`. Without either, the built-in `auto` applies. The items:

- `alignfirst` selects the whole `alignfirst.json`/`.jsonc` family. Both extensions in the selected location fail, and sections are never merged across sources.
- `.alignfirst-instructions` holds `context.md`, described in step 4.
- `assistantInstructionsFile` selects the root for the configuration's relative reference. Without a reference, its location is null; no file name is discovered.
- `workspaceRuntime` uses external storage only when it is effectively `companion`. `project` and `auto` always keep the runtime local, whether or not a directory exists.
- `docs` holds the Docmap tree.
- `.plans` holds the work files.
- `_aligndev` accepts `companion` or `auto`. Explicit `companion` stores sessions in the companion, shaped like plans. `auto` follows the effective plans. When unset, a `companion` default stores sessions in the companion; otherwise sessions follow the plans. Companion sessions with `auto` plans are rejected, because creating them would change the plans selection.

The retired `DEVELOPERS.md` item supplies no selection.

Ordinary `auto` selects an existing companion item, then an existing project item, then the companion as creation destination. Explicit `project` or `companion` selects that destination even when it is missing.

With `.plans` alone in the companion, existing project plans stay untouched and unused. Do not copy, merge, migrate, archive or delete them.

## 3. Verify the selection

Run `{{CMD}} config --json`. Check `locations` and `selectionOrigins`, and that `.plans` and every intended write resolve inside `companion.dir`. Stop when the selection sends an unauthorized write into the project. A missing companion directory is a destination, not a fallback signal. A profile-only registration supplies no companion placement.

## 4. Prepare the selected files

`setup init` writes the configuration and creates the work files at their selected locations. Existing content is preserved. The format is in `{{CMD}} setup guide configuration`.

Add `.alignfirst-instructions/context.md` for coding-agent context that the settings do not carry. It holds no bootstrap section. `{{CMD}} context` prints it. Keep it distinct from human and assistant instructions.

For documentation, use the repository's existing docs, or bootstrap companion docs when requested (`{{CMD}} setup guide docmap-bootstrap`). Untouched mode writes no runtime or version file into the project.

With a separately authorized work-files repository, `{{CMD}} plans setup <clone>` creates its link at the selected location (`{{CMD}} setup guide work-files`). Verify that existing linked worktrees resolve to the same target and selection. The project needs no plans link of its own.

For workspaces, the companion can supply the complete recipe and the external runtime; see `{{CMD}} setup guide workspace`.

## 5. Global instructions line

A repository without the bootstrap section, such as one whose default location is `companion`, needs the line in the developer's global agent instructions: `~/.claude/CLAUDE.md` (under `$CLAUDE_CONFIG_DIR` when set), `~/.codex/AGENTS.md`, `~/.pi/agent/AGENTS.md` or the agent's equivalent. Agents do not read a companion's `AGENTS.md` on their own. When the default location is `companion`, `{{CMD}} setup init` and `{{CMD}} setup instructions` print the section with the project's path filled in. Elsewhere, use its form:

```markdown
## AlignFirst - Start every session with the project context

When you work on the project `/path/to/a/project`, run `{{CMD}} context` from the repository root once, as your first command in the session, whatever the task.
```

Offer it to a direct interactive developer; the developer approves before it is written. Each further project adds its own line to the same section. The section uses no agent-specific mechanism.

Assistant deployments skip the line: AlignDev supplies the context to new coding children and keeps the native permission handling. A shared symlink grants no sandbox access. Report permission refusals without silently widening permissions.

## 6. Check

Run `{{CMD}} doctor` and `git status`. An untouched protocols or Docmap preparation shows no repository change.

## Change placement safely

Before changing the configuration source, the placement or the companion's ownership, account for the workspace resources and clean them under the old selection. There is no placement history, no migration on read and no recovery of manually hidden locations. Keep the absolute paths for manual recovery.

`{{CMD}} companion unregister` refuses outstanding resources or incomplete disposal, even with force. It may retain clean data, and reports the paths whose automatic discovery it removes. Reading this topic authorizes no live registry mutation and no change for external consumers.

## Independent profiles and session trees

A registry entry `{ "aligndev": { "profile": "name" } }` selects an AlignDev profile without relocating files or using a companion directory. When unregister removes the companion fields of a combined entry, the profile selection stays. Companion contents remain unless their deletion is separately authorized.

For AlignDev sessions outside usable project plans, run `{{CMD}} companion register --item .plans=project --item _aligndev=companion`. The effective plans stay untracked by the product repository, and a shared work-files repository remains supported. The session histories stay independent.
