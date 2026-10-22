# Runbook: Work-files setup

Prepare usable work files before ticket reservation, request capture, coding delegation, or discussion recording. This procedure needs only PROJECT_PATH, the project's main-worktree path. It needs no ticket, branch, or new worktree.

For explicit companion-only onboarding, start at section 3 under the onboarding authorization, even when existing project plans are usable. That route requires registration and an explicit companion-plans selection independently of the readiness gate below.

## 1. Check the effective work files

Run `{{ALIGNFIRST}} plans check --json` from PROJECT_PATH. It reads the effective `.plans` location from `{{ALIGNFIRST}} config --json`, where explicit `project` or `companion` selections win and, under `auto`, an existing companion copy wins over an existing project copy; when neither exists, a registered companion is the creation target. The check passes when that location is a usable directory with no file tracked by this project's own repository, through a tracked symlink, mixed tracked/untracked contents, or an alias into tracked files included. A separate work-files repository may track its contents, and an unused tracked project `.plans` is not a blocker when a usable companion is effective.

If `--json` is rejected, the selected AlignFirst CLI needs upgrading alongside AlignDev. With `npx`, check the project's local `alignfirst` dependency, which takes precedence over the cached or global CLI. Retry the JSON check after upgrading; do not substitute a plain-text check.

When an existing linked worktree is selected, run the command there too: it also requires the same effective target as the main worktree. A different location is an error: do not create a second history or repair links silently.

Usable, non-project-tracked effective plans need no preparation: resume the interrupted operation. Any other failure (broken links, invalid configuration, unreadable paths, conflicting non-directory files) is reported, not repaired.

## 2. Obtain approval when preparation is needed

When effective plans are missing or project-tracked, including an add failure because the intended branch tracks project-local plans, ask in the user's language unless preparation is already authorized: "{Reason}. May I select companion-backed work files for all this project's worktrees, leaving the existing project work files untouched and unused?" Keep the all-worktree scope and preservation promise in the approval question. Do not copy, merge, migrate, archive, or delete existing work files, and do not ask about copying them.

Wait for approval before changing registration, selection, or directories. Do not reserve a temporary ticket or create a temporary worktree to prepare work files.

## 3. Select and verify companion plans

After approval:

1. If no companion is registered, run `{{ALIGNFIRST}} companion register` from PROJECT_PATH. This also preserves a profile-only registration.
2. Reread `{{ALIGNFIRST}} config --json`. Retain `companion.dir` and `companion.key`; use the reported key exactly.
3. Read `~/.alignfirst/companions/registry.json` before editing. Its project entries live under `projects`. Edit only `projects[companion.key]`, setting `items[".plans"]` to `"companion"` within that entry. Use the key reported by config, not a guessed key or a new top-level `items` object. Preserve all other fields, item settings, profile selections, and entries.
4. Reread `{{ALIGNFIRST}} config --json`. Verify that `locations[".plans"].in` is `"companion"` and its path is the selected companion's `.plans`. Create that directory if missing, preserving existing contents. Do not create a worktree `.plans` link for companion plans.
5. Run `{{ALIGNFIRST}} plans check --json` again from PROJECT_PATH, and from any already selected worktree, then resume the interrupted operation.

This is the sole assistant preparation procedure. `{{ALIGNDEV}} worktree add` and coding launches validate work files; they do not authorize this selection or provision missing plans.
