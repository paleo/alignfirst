# Runbook: Work-files setup

Prepare usable work files before ticket reservation, request capture, coding delegation, or discussion recording. This procedure needs only PROJECT_PATH, the project's main-worktree path. It needs no ticket, branch, or new worktree.

## 1. Inspect the effective location

Run `{{ALIGNFIRST}} config --json` from PROJECT_PATH and read `locations[".plans"]`. The report is authoritative. Explicit `project` or `companion` selections win. Under `auto`, an existing companion copy wins over an existing project copy; when neither exists, a registered companion is the creation target.

Check the reported path read-only, including its resolved real path. It must be a usable directory. Run `{{ALIGNFIRST}} plans check` from PROJECT_PATH (or the selected worktree during its verification): it validates usability, but does not enforce AlignDev's tracking rule.

Check whether the effective path contains files tracked by this project's Git repository. Use `git --literal-pathspecs ls-files -z -- <relative-path>` from the containing worktree root, checking the directory itself as well as descendants, including a tracked symlink and mixed tracked/untracked contents. Check the resolved source too: compare `git rev-parse --path-format=absolute --git-common-dir` identities so an untracked alias into this project's tracked files cannot bypass the rule. A separate work-files repository may track its contents. An unused tracked project `.plans` is not a blocker when a usable companion is effective.

When an existing linked worktree is selected, repeat these checks there with its actual `config --json` report. Its effective work files must resolve to the same shared target selected from PROJECT_PATH. A different location is an error: do not create a second history or repair links silently.

Usable, non-project-tracked effective plans need no preparation. Resume the interrupted operation. Broken links, invalid configuration, unreadable paths, and conflicting non-directory files remain errors; report them rather than replacing them.

## 2. Obtain approval when preparation is needed

When effective plans are missing or project-tracked, including an add failure because the intended branch tracks project-local plans, explain the reason and ask to select companion-backed work files, unless that preparation is already authorized. Explain that this selection applies to all worktrees. Existing project work files stay untouched and unused. Do not copy, merge, migrate, archive, or delete them, and do not ask about copying them.

Wait for approval before changing registration, selection, or directories. Do not reserve a temporary ticket or create a temporary worktree to prepare work files.

## 3. Select and verify companion plans

After approval:

1. If no companion is registered, run `{{ALIGNFIRST}} companion register` from PROJECT_PATH. This also preserves a profile-only registration.
2. Reread `{{ALIGNFIRST}} config --json`. Retain `companion.dir` and `companion.key`; use the reported key exactly.
3. Edit only that entry in `~/.alignfirst/companions/registry.json`, setting `items[".plans"]` to `"companion"`. Preserve all other fields, item settings, profile selections, and entries.
4. Reread `{{ALIGNFIRST}} config --json`. Verify that `locations[".plans"].in` is `"companion"` and its path is the selected companion's `.plans`. Create that directory if missing, preserving existing contents. Do not create a worktree `.plans` link for companion plans.
5. Repeat the read-only usability and tracking checks in section 1. Verify the effective location in any already selected worktree too, then resume the interrupted operation.

This is the sole assistant preparation procedure. `{{ALIGNDEV}} worktree add` and coding launches validate work files; they do not authorize this selection or provision missing plans.
