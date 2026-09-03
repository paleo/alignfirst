# Team Plans Repository Setup

Share `.plans/` through a dedicated team repository. Solo users keep `.plans/` as a local directory.

## How It Works

The team hosts one private, multi-project plans repository:

```text
myteam-plans/
  project-a/
    250/
      A1-spec.md
    _archives/
  project-b/
    103/
```

Each developer clones this repository once per machine with their own credentials, anywhere they
choose, typically beside the code repositories. In a configured project, `.plans` is a symlink to
the folder named by `plans.folder` in `.alignfirst.json`. Linked worktrees continue through the main
worktree's symlink.

A contributor without access to the plans repository uses a plain `.plans` directory. The CLI
accepts both modes. Run `alignfirst plans check` to report the current mode.

`alignfirst sync --auto-archive` publishes changes and archives stale ticket directories and
no-ticket session files under `_archives/`. `ALIGNFIRST_ARCHIVE_DAYS` sets the threshold in days and
defaults to `7`.

## Configure the Project

Set the project folder during the initial setup:

```sh
alignfirst setup --plans-folder project-a
```

When `.alignfirst.json` already exists without `plans.folder`, supply the folder once while linking:

```sh
alignfirst plans setup <plans-clone-path> --folder project-a
```

Ensure the instruction file says:

> After every change in `.plans/`, run `alignfirst sync`.

For a project prepared for an AlignFirst Developer, the `.plans/` entry in `DEVELOPERS.md` also
names the shared repository and the sync command.

## Configure Each Machine

Clone the plans repository with the developer's own credentials. From the project root, link it:

```sh
git clone <plans-repository-url> ../myteam-plans
alignfirst plans setup ../myteam-plans
alignfirst sync --auto-archive
```

`alignfirst plans setup` creates the configured project folder in the clone, migrates an existing
local `.plans`, and replaces it with a relative symlink. Re-run it after moving the clone.

For local mode, create the directory instead:

```sh
mkdir .plans
```

## With the Workspace System

When the project also uses workspace, check the link before setting up the main worktree:

```js
preSetup: ({ isMainWorktree, currentWorktree }) => {
  if (!isMainWorktree) return;
  execFileSync("alignfirst", ["plans", "check"], {
    cwd: currentWorktree,
    stdio: "inherit",
  });
},
```

Keep the `isMainWorktree` gate. `preSetup` runs before the kernel creates shared-directory symlinks,
so a fresh linked worktree has no `.plans` yet. The check accepts a usable plans symlink and a local
directory.

Document these new-machine steps in `README.md` before workspace setup:

```sh
npm install -g alignfirst
npm install
git clone <plans-repository-url> <plans-clone-path>
alignfirst plans setup <plans-clone-path>
npm run workspace -- setup
```

For a public repository, make local mode the default and avoid naming a private repository:

```sh
npm install -g alignfirst
npm install
mkdir .plans   # or run alignfirst plans setup with the team plans clone
npm run workspace -- setup
```
