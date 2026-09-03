# Upgrade from AlignFirst v3

Replace the full-content v3 skills and plans package with the AlignFirst CLI and v4 stub skills.

## Install the CLI

Install the CLI globally on each developer machine. An AlignFirst Developer host also replaces the
retired project-discovery package:

```sh
npm install -g alignfirst
# AlignFirst Developer host only
npm install -g alignfirst @paleo/alcode
npm uninstall -g @paleo/alproject
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
use `^\d+$`; Jira-like keys use `^[A-Z]+-\d+$`; omit the option when there is no convention.

If the old `plans:setup` script named a folder, preserve it with `--plans-folder`:

```sh
alignfirst setup --ticket-pattern '<regex>' [--plans-folder <old-folder>]
```

Include `--port-range <first>-<last>` when the workspace wrapper declares a port scheme. The command
writes `.alignfirst.json`, keeps `.plans`, updates the README prerequisite, and installs the stubs.

## Replace Project Commands

In `AGENTS.md` or `CLAUDE.md`:

- Replace `npm run plans:sync` with `alignfirst sync`.
- Replace `npm run docmap` with `alignfirst docmap` when the project adopts docmap through the CLI.

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
alignfirst doctor
```
