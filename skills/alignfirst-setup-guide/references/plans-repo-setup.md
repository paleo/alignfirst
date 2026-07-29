# Team Plans Repository Setup

Share `.plans/` among the developers of a team through a dedicated **plans repository**. This is an optional overlay over the AlignFirst skills setup: solo users skip it, and the skills read and write `.plans` identically in both modes.

## How It Works

The team hosts a plans repository, multi-project — one folder per code repo, ticket directories inside:

```text
myteam-plans/
  project-a/
    250/
      A1-spec.md
    _archives/
  project-b/
    103/
```

On each machine, the repository is cloned once, wherever the user wants (typically next to the other repos). In each project, `.plans` in the main worktree is a symlink to the project's folder inside the clone. Plans never enter the product repository. Linked worktrees created by the workspace system keep pointing at the main worktree's `.plans`; the symlink chain resolves on its own.

Plan history has no value, so the plans repository only receives synchronization commits (`sync`). Syncing is manual, at each user's discretion — a forgotten sync means a teammate sees a stale version, never pollution. The skills never trigger a sync and never detect which mode they run in.

To keep `.plans/` small, finished tickets are moved to `_archives/` inside the project folder — by anyone, at any time (e.g. `mv .plans/250 .plans/_archives/`).

## Setup, Once Per Team

Create the plans repository on the team's git host (recommended name: `{team-name}-plans`). Keep it private; its access rights define who sees the plans. Plans of a project must be visible to all its contributors, so a repo contributed to by several teams must pick a single plans repository.

## Setup, Once Per Project

1. Install the tool: `npm install -D @paleo/plans-repo`.
2. Add the npm scripts, with the project's folder name baked in:

   ```json
   "plans:setup": "plans-repo setup --folder project-a",
   "plans:sync": "plans-repo sync"
   ```

3. Ensure `.gitignore` contains `.plans` (the skills setup already does this).
4. Add this section to the instruction file (`AGENTS.md` or `CLAUDE.md`), adapting the URL, folder, and commands to the project and the detected package manager:

   > ## Team Plans Repository
   >
   > In the main worktree, `.plans` is a symlink into a clone of the team plans repository: `git@example.com:myteam/myteam-plans.git` (folder `project-a/`). Plans are shared with the team through that repository and are never committed in this one.
   >
   > To synchronize: `npm run plans:sync`.
   >
   > On a new machine: clone the plans repository anywhere (typically next to the worktrees), then run `npm run plans:setup -- <clone-location>`.

## Setup, Once Per Machine

Clone the plans repository anywhere (typically next to the worktrees) — cloning is the user's move, with their own SSH configuration. Then, from the main worktree root, pass the clone location:

```sh
npm run plans:setup -- ../myteam-plans
```

The command creates the project folder inside the clone, migrates any existing `.plans` content into it, and replaces `.plans` with the symlink. A moved clone leaves a broken symlink — re-run the command with the new location.

Then publish any migrated content: `npm run plans:sync`.
