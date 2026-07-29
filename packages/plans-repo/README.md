# @paleo/plans-repo

Share the `.plans` directory of the [AlignFirst skills](https://github.com/paleo/alignfirst) through a dedicated team plans repository.

## How it works

A team hosts a plans repository, multi-project — one folder per code repo, ticket directories inside:

```text
team-plans/
  project-a/
    250/
      A1-spec.md
    _archives/
  project-b/
    103/
```

Each developer clones it once per machine. In each project, `.plans` in the main worktree becomes a symlink to the project's folder inside the clone. Plans never enter the product repository: its `.gitignore` carries a bare `.plans` line.

Plan history has no value, so the plans repository only receives synchronization commits — pull, commit `sync`, push — at each user's discretion.

## Install

```sh
npm install -D @paleo/plans-repo
```

Add the npm scripts, with the remote URL and project folder baked in:

```json
{
  "plans:setup": "plans-repo setup --repo git@example.com:team/team-plans.git --folder project-a",
  "plans:sync": "plans-repo sync"
}
```

## Commands

Once per machine, from the main worktree root, passing the clone location:

```sh
npm run plans:setup -- ../team-plans
```

`setup` clones the repository there (or verifies an existing clone's origin), migrates any existing `.plans` content into it, and creates the symlink. Re-run it with the new location if the clone moves.

To synchronize, from any worktree:

```sh
npm run plans:sync
```

## Archiving

To keep `.plans` small, move finished tickets to `_archives/` inside the project folder — anyone, anytime:

```sh
mv .plans/250 .plans/_archives/
```
