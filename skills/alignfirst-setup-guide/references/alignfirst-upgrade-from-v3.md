# Upgrade from AlignFirst v3

Replace the full-content v3 skills and plans package with the AlignFirst CLI and v4 stub skills.

## Install the CLI

Install the CLI globally on each developer machine. An AlignFirst Developer host also replaces the
retired project-discovery package:

```sh
npm install -g alignfirst
# AlignFirst Developer host only
npm install -g alignfirst @paleo/alcode @paleo/alproject
```

## Remove the Plans Package

Remove `@paleo/plans-share` from the project's dev dependencies and delete the `plans:setup` and
`plans:sync` scripts. Keep `.plans` unchanged; an existing symlink remains valid.

Use the detected package manager. For npm:

```sh
npm uninstall -D @paleo/plans-share
npm pkg delete scripts.plans:setup scripts.plans:sync
```

## Create the Project Config

Detect the ticket pattern from the repository's branch and ticket conventions. Issue-number tickets
use `^\d+$`; Jira-like keys use `^[A-Z]+-\d+$`; omit the field when there is no convention.

Write `.alignfirst.json` by hand. Preserve the folder named by the old `plans:setup` script:

```json
{
  "schemaVersion": 1,
  "ticketIdPattern": "<regex>",
  "plans": { "folder": "<old-folder>" },
  "git": { "defaultBranch": "<detected-default-branch>" }
}
```

Add `portRange` when the workspace wrapper declares a port scheme. Keep `.plans`, update the README
prerequisite, and install the stubs.

## Replace Project Commands

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
effective project:

```sh
alignfirst config
alignfirst doctor
```
