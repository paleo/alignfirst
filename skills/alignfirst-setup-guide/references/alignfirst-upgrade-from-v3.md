# Upgrade from AlignFirst v3

Replace the full-content v3 skills and plans package with the AlignFirst CLI and v4 stub skills. The
migration leaves no plans compatibility package or npm-script wrappers.

## Install the CLI

Install the CLI globally on each developer machine. An AlignFirst Developer host also replaces the
retired project-discovery package:

```sh
npm install -g alignfirst
# AlignFirst Developer host only
npm install -g alignfirst @paleo/alcode @paleo/alproject
```

## Inventory the Plans Contract

Before removing anything, search the whole repository, excluding dependencies and generated output,
for:

- `plans-share` and `@paleo/plans-share`;
- `plans:setup` and `plans:sync`;
- `PLANS_SHARE_ARCHIVE_DAYS`;
- setup, sync, check, archive, and auto-archive calls.

Include documentation, CI, package scripts, shell scripts, hooks, deployment files, and automation.
Record the plans folder and whether synchronization uses `--auto-archive`.

Recover the plans folder from the static `--folder` value in the old setup script or another setup
call. If that value is absent or dynamic and `.plans` is a symlink, resolve its target and use the
target directory's basename after verifying that its parent is the plans repository clone. Use an
existing `plans.folder` when it agrees. Ask the user when these sources are missing or conflict.

Keep `.plans` unchanged; an existing symlink remains valid.

## Remove the Plans Package and Scripts

Remove `@paleo/plans-share` from the project's development dependencies. Delete `plans:setup` and
`plans:sync`; do not retain them as wrappers. Use the detected package manager so its lockfile is
updated. For npm:

```sh
npm uninstall -D @paleo/plans-share
npm pkg delete scripts.plans:setup scripts.plans:sync
```

## Create the Project Config

Detect the ticket pattern from the repository's branch and ticket conventions. Issue-number tickets
use `^\d+$`; Jira-like keys use `^[A-Z]+-\d+$`; omit the field when there is no convention.

Write `.alignfirst.json` by hand. Preserve the recovered plans folder. When the old synchronization
path used `--auto-archive`, preserve that behavior with `plans.autoArchive: true`:

```json
{
  "schemaVersion": 1,
  "ticketIdPattern": "<regex>",
  "plans": { "folder": "<recovered-folder>", "autoArchive": true },
  "git": { "defaultBranch": "<detected-default-branch>" }
}
```

Keep only applicable plans fields. `plans.autoArchive` works in local mode without `plans.folder`.
Add `portRange` when the workspace wrapper declares a port scheme. Update the README prerequisite
and install the stubs.

## Replace Every Legacy Command

Use these replacements throughout the repository:

| Legacy command or setting | Replacement |
| --- | --- |
| `plans-share setup <clone> --folder <folder>` | Set `plans.folder`, then run `alignfirst plans setup <clone>` |
| `plans-share sync` | `alignfirst sync` |
| `plans-share sync --auto-archive` | Set `plans.autoArchive: true`, then run `alignfirst sync` |
| `plans-share check` | `alignfirst plans check` |
| `plans-share archive <ticket>` | `alignfirst plans archive <ticket>` |
| `plans-share auto-archive` | `alignfirst plans auto-archive` |
| `PLANS_SHARE_ARCHIVE_DAYS` | `ALIGNFIRST_ARCHIVE_DAYS` |

Replace every caller of the deleted npm scripts with the direct `alignfirst` command. Repeat the
repository-wide search after editing. No active legacy command, package reference, script name, or
environment variable may remain; report any historical reference retained on purpose.

## Replace Project Instructions

Replace the AlignFirst section in `AGENTS.md` or `CLAUDE.md` with the bootstrap line from
`alignfirst-skills-setup.md`. Use `alignfirst context` when the project adopts docmap through the CLI;
this also replaces the `npm run docmap` instruction.

In `workspace.mjs`, replace the main-worktree plans check with:

```js
preSetup: ({ isMainWorktree, currentWorktree }) => {
  if (!isMainWorktree) return;
  execFileSync("alignfirst", ["plans", "check"], {
    cwd: currentWorktree,
    stdio: "inherit",
  });
},
```

Keep a distinct `preSetup` guard for remote-development requirements when the project has one.

## Update the Skills

Replace the v3 protocol content with the v4 stubs:

```sh
npx -y skills update --global --yes
```

Use `--project` instead of `--global` for a project-local installation. Finish by checking the
effective project and the plans workflow:

```sh
alignfirst config
alignfirst plans check
alignfirst sync
alignfirst doctor
```

Inspect the complete doctor output. Its exit status does not reflect reported problems; resolve every
`[error]` line before considering the migration complete. Confirm the final legacy search has no
active matches.
