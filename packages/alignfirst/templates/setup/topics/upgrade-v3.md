# Upgrade from Full-Content Skills

Replace full-content protocol skills and the `plans-share` package with the AlignFirst CLI and CLI-backed stub skills. The migration leaves no `plans-share` compatibility package or npm-script wrappers.

## The CLI

The migrated project invokes the CLI as `{{CMD}}` and declares no dependency on it. An AlignDev OpenClaw host installs its protected CLIs through its own update runbook.

## Inventory the `plans-share` Contract

Before removing anything, search the whole repository, excluding dependencies and generated output, for:

- `plans-share` and `@paleo/plans-share`;
- `plans:setup` and `plans:sync`;
- `PLANS_SHARE_ARCHIVE_DAYS`;
- setup, sync, check, archive and auto-archive calls.

Include documentation, CI, package scripts, shell scripts, hooks, deployment files and automation. Record the work-files folder.

Recover the work-files folder from the static `--folder` value in the old setup script or another setup call. If that value is absent or dynamic and `.plans` is a symlink, resolve its target and use the target directory's basename, after verifying that its parent is the work-files repository clone. Use an existing `plans.repositoryFolder` when it agrees. Ask the user when these sources are missing or conflict.

Keep `.plans` unchanged; an existing symlink remains valid.

## Remove the Plans Package and Scripts

Remove `@paleo/plans-share` from the project's development dependencies. Delete `plans:setup` and `plans:sync`; do not retain them as wrappers. Use the detected package manager so its lockfile is updated. For npm:

```sh
npm uninstall -D @paleo/plans-share
npm pkg delete scripts.plans:setup scripts.plans:sync
```

## Create the Project Configuration

Detect the ticket pattern from the repository's branch and ticket conventions. Issue-number tickets use `^\d+$`; Jira-like keys use `^[A-Z]+-\d+$`. Omit the flag when there is no convention. `{{CMD}} setup guide protocols` details the other conventions.

Run `{{CMD}} setup init` with the recovered work-files folder:

```sh
{{CMD}} setup init \
  --ticket-pattern '<regex>' \
  --default-branch <detected-default-branch> \
  --plans-folder <recovered-folder>
```

It writes `alignfirst.json` with `schemaVersion: 1`, the conventions, and `plans` with `repositoryFolder` and `autoArchive: true`, including in local mode; the user can remove `autoArchive` to opt out. It also inserts the bootstrap section into `AGENTS.md` or `CLAUDE.md` when none exists. When a configuration file already exists, the command leaves it unchanged: set `plans.repositoryFolder` and `plans.autoArchive: true` by hand.

Port ranges belong only in the selected merged configuration's `devServer.ports`. Existing workspace wrappers or registries require `{{CMD}} setup guide upgrade-workspaces` before conversion. Update the README guidance and install the requested stubs.

## Replace Every Legacy Command

Use these replacements throughout the repository:

| Legacy command or setting | Replacement |
| --- | --- |
| `plans-share setup <clone> --folder <folder>` | Set `plans.repositoryFolder`, then run `{{CMD}} plans setup <clone>` |
| `plans-share sync` | `{{CMD}} sync` |
| `plans-share sync --auto-archive` | Set `plans.autoArchive: true`, then run `{{CMD}} sync` |
| `plans-share check` | `{{CMD}} plans check` |
| `plans-share archive <ticket>` | `{{CMD}} plans archive <ticket>` |
| `plans-share auto-archive` | `{{CMD}} plans auto-archive` |
| `PLANS_SHARE_ARCHIVE_DAYS` | `ALIGNFIRST_ARCHIVE_DAYS` |

Replace every caller of the deleted npm scripts with the direct `{{CMD}}` command. Repeat the repository-wide search after editing. No active legacy command, package reference, script name or environment variable may remain; report any historical reference retained on purpose.

## Replace Project Instructions

Remove the old AlignFirst section from `AGENTS.md` or `CLAUDE.md`; the bootstrap section replaces it. The bootstrap section also replaces the `npm run docmap` instruction when the project adopts Docmap through the CLI. Run `{{CMD}} setup instructions` and handle its status as `{{CMD}} setup guide protocols` describes.

`{{CMD}} workspace setup` validates effective plans and the selected runtime storage (ignored and untracked when project-local) before creation. Prepare these prerequisites separately; no wrapper check is needed. Move any project-specific remote-development guard into a recipe command during the coordinated cutover.

## Update the Skills

Replace the full protocol content with CLI-backed stubs:

```sh
{{SKILLS}} update --global --yes
```

`{{CMD}} setup guide skills` covers new installations.

## Check

Finish by checking the effective project and the work-files link:

```sh
{{CMD}} config
{{CMD}} plans check
{{CMD}} sync
{{CMD}} doctor
```

Inspect the complete doctor output. Its exit status does not reflect reported problems; resolve every `[error]` line before considering the migration complete. Confirm the final legacy search has no active matches.
