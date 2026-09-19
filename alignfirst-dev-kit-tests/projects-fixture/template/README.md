# Comparables

A small full-stack product monorepo (API + frontend): region pages and a CSV export.

## Getting started

```sh
pnpm i
pnpm workspace setup
```

The everyday workflow is in [`DEVELOPERS.md`](DEVELOPERS.md).

### Remote access

When the dev server is reached through the HTTPS gateway, set up the main worktree with the `remote` profile:

```sh
export REMOTE_DEV_DOMAIN=dev.example.org
pnpm workspace setup --profile remote
```
