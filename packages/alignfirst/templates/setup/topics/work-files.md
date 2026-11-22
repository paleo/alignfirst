# Work-Files Repository

Work files live in `.plans`, in one of two modes:

- **Local**: an ignored directory in the project. `{{CMD}} setup init` creates it and its ignore rule.
- **Shared**: a link to a separate team repository, which tracks the work files of several projects.

The product repository must never track the effective `.plans`; a separate work-files repository may. A public project's README offers local mode, without exposing a private work-files URL.

## Shared mode

The team repository holds one folder per project, with its ticket directories and `_archives/`. `plans.repositoryFolder` selects the project's folder: pass `--plans-folder <name>` to `setup init`, or add it to an existing configuration. The deprecated `plans.folder` spelling is rejected. Projects that still use `.alignfirst.json` follow `{{CMD}} setup guide upgrade-workspaces`.

On each machine, clone the repository with the developer's credentials, then link it from the project:

```sh
git clone <plans-repository-url> <plans-clone-path>
{{CMD}} plans setup <plans-clone-path>
{{CMD}} plans check
{{CMD}} sync
```

Without `repositoryFolder`, pass `--folder <name>` to `plans setup` once. `plans setup` creates the project's folder and may migrate existing local plans into the separate repository: obtain authorization before moving existing history. It creates a relative symlink at the effective plans location, including in a selected companion. Re-run it after moving the clone.

## Archival and sync

`plans.autoArchive: true`, which `setup init` writes in both modes, makes sync archive stale tickets and completed no-ticket sessions under `_archives/`. Remove it to opt out. `ALIGNFIRST_ARCHIVE_DAYS` sets the staleness threshold, 7 days by default. Running `_aligndev/*.running.md` logs are excluded from snapshots.

Shared sync serializes through a lock on the clone, consolidates pending sync commits, and retries up to three times when the remote is busy or advancing. A conflict aborts the rebase and keeps the local commits: resolve it in the clone with `git pull --rebase`, then run sync again.

With the `alignfirst context` bootstrap section, the CLI supplies the sync instruction; do not repeat it in the project's guides. Without that section, document the rule: after every `.plans` change, run `{{CMD}} sync`. Mention work-files provisioning in the README's local installation procedure only when it requires a manual step.

## Before workspace setup

Prepare the effective plans before the first `{{CMD}} workspace setup`. The CLI validates them on main before creating a branch or worktree, then checks that each linked worktree resolves to the same target; no wrapper check is needed. Main's project-local plans are shared with linked worktrees through a link. Companion plans resolve directly, without a link.

For an assistant, the work-files preparation follows `{{CMD}} setup guide assistant-project`.
