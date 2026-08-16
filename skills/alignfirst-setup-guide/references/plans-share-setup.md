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

A contributor without access to the plans repository leaves `.plans` as a plain directory. `sync` then reports local plans mode and exits successfully, and the skills work unchanged. Run `plans-share check` to report which mode a project is in.

Plan history has no value, so the plans repository only receives synchronization commits (`sync`). The instruction file asks the agent to sync after each change in `.plans/`; a forgotten sync means a teammate sees a stale version, never pollution. The skills themselves never trigger a sync and never detect which mode they run in.

To keep `.plans/` small, finished tickets are moved to `_archives/` inside the project folder — by anyone, at any time (e.g. `mv .plans/250 .plans/_archives/`).

## Setup, Once Per Team

Create the plans repository on the team's git host (recommended name: `{team-name}-plans`). Keep it private; its access rights define who sees the plans. Plans of a project must be visible to all its contributors, so a repo contributed to by several teams must pick a single plans repository.

## Setup, Once Per Project

1. Install the tool: `npm install -D @paleo/plans-share`.
2. Add the npm scripts, with the project's folder name baked in:

   ```json
   "plans:setup": "plans-share setup --folder project-a",
   "plans:sync": "plans-share sync"
   ```

3. Ensure `.gitignore` contains `.plans` (the skills setup already does this).
4. Add this subsection to the instruction file (`AGENTS.md` or `CLAUDE.md`), under the AlignFirst section added by the skills setup, adapting the folder and the commands to the project and the detected package manager:

   > ### Team Plans Repository
   >
   > In the main worktree, `.plans` is a symlink into a clone of the team plans repository (folder `project-a/`). Plans are shared with the team through that repository and are never committed in this one.
   >
   > After every change in `.plans/`, synchronize the plans: `npm run plans:sync`.

## Setup, Once Per Machine

Clone the plans repository anywhere (typically next to the worktrees) — cloning is the user's move, with their own SSH configuration. Then, from the main worktree root, pass the clone location:

```sh
npm run plans:setup -- ../myteam-plans
```

The command creates the project folder inside the clone, migrates any existing `.plans` content into it, and replaces `.plans` with the symlink. A moved clone leaves a broken symlink — re-run the command with the new location.

Then publish any migrated content: `npm run plans:sync`.

A contributor without access to the clone creates the directory instead: `mkdir .plans`. Either way `.plans` must exist before the workspace bootstrap, which fails on a missing one.

## With the Workspace System (Recommended)

When the project also uses the workspace system, make the link a prerequisite of the local environment:

1. In the `preSetup` callback of `workspace.mjs`, add the check. The clone location stays the user's choice, nothing is hardcoded:

   ```js
   if (isMainWorktree) {
     execFileSync("npx", ["--no", "plans-share", "check"], {
       cwd: currentWorktree,
       stdio: "inherit",
     });
   }
   ```

   An unusable `.plans` then fails `workspace setup`, with the check's guidance on stderr. `check` accepts both a symlink into the clone and a plain local directory, so a contributor without access to the plans repository still sets up.

   Keep the `isMainWorktree` gate: `preSetup` runs before the kernel symlinks the shared directories, so a fresh linked worktree has no `.plans` yet. The main worktree is subject to the same ordering — nothing creates `.plans` before the check — so a fresh clone must get it beforehand, which is what the README step below documents.

   Pass `--no` to keep npx off the registry. The bin is `plans-share`, while the package is `@paleo/plans-share`.

2. Document the new-machine steps in `README.md` (the entry point that owns fresh-clone setup), before the workspace bootstrap command. Then drop the "On a new machine" line from the instruction-file section: machine setup is covered where machines get installed.

   In a **public repository**, write the local mode as the default and name no private repository:

   ```sh
   npm install
   mkdir .plans   # or use plans:setup if you have a team plans repository
   npm run workspace -- setup
   ```

   An outside contributor then reads a step that works for them, and the inline comment points teammates at `plans:setup -- <clone-location>` without exposing where the clone lives. A private repository can spell the clone step out instead.
