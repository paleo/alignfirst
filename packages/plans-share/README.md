# @paleo/plans-share

Share the `.plans` directory of the [AlignFirst skills](https://github.com/paleo/alignfirst) through a dedicated team plans repository.

## How it works

A team hosts a plans repository, multi-project — one folder per code repo, ticket directories inside:

```text
myteam-plans/
  project-a/
    250/
      A1-spec.md
    _archives/
  project-b/
    103/
```

Each developer clones it once per machine. In each project, `.plans` in the main worktree becomes a symlink to the project's folder inside the clone. Plans never enter the product repository: its `.gitignore` contains `.plans`.

Plan history has no value, so the plans repository only receives synchronization commits — pull, commit `sync`, push — at each user's discretion.

## Install

```sh
npm install -D @paleo/plans-share
```

Add the npm scripts, with the project folder baked in:

```json
{
  "plans:setup": "plans-share setup --folder project-a",
  "plans:sync": "plans-share sync --auto-archive"
}
```

Document the plans repository URL where developers will find it (e.g. `AGENTS.md`), since cloning is theirs to do — with their own SSH configuration.

## Commands

Once per machine: clone the plans repository anywhere (typically next to the other repos), then, from the main worktree root, pass the clone location:

```sh
npm run plans:setup -- ../myteam-plans
```

`setup` migrates any existing `.plans` content into the clone and creates the symlink. Re-run it with the new location if the clone moves.

To synchronize, from any worktree:

```sh
npm run plans:sync
```

A project may keep `.plans` as a plain local directory. `sync` then reports local plans mode and exits successfully.

Archive one ticket immediately by id or path:

```sh
npx --no plans-share archive 250
npx --no plans-share archive .plans/250
```

Archive stale entries without synchronizing:

```sh
npx --no plans-share auto-archive
```

Pass `--auto-archive` to `sync` to archive stale entries after pulling and before committing. The recommended `plans:sync` script above enables it.

To verify that `.plans` is usable and report its mode:

```sh
npx --no plans-share check
```

Two modes exit 0:

- **shared** — a symlink into the plans repository clone.
- **local** — a plain directory. Synchronization is disabled.

It exits 1 when `.plans` is unusable: missing, a broken symlink, not a directory, or a symlink leading outside any git repository.

Pass `--no` to keep npx off the registry. The bin is `plans-share`, while the package is `@paleo/plans-share`.

## Archiving

Automatic archiving moves stale ticket directories and stale no-ticket session files from `.plans/_alcode/` into `.plans/_archives/`. A ticket's age is the newest modification time among its files. `PLANS_SHARE_ARCHIVE_DAYS` sets the threshold in days and defaults to `7`.

Existing names gain a numeric suffix, such as `250-2` or `20260101-101010-2.md`.

Manual moves remain valid:

```sh
mv .plans/250 .plans/_archives/
```
