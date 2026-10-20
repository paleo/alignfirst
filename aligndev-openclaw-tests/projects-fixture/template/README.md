# Comparables

A small full-stack product monorepo (API + frontend): region pages and a CSV export.

## Getting started

```sh
pnpm i
pnpm workspace setup
pnpm dev
```

Workspace setup installs dependencies. The first `pnpm dev` or `pnpm dev setup` allocates ports and creates `local.env`.

The everyday workflow is in [`DEVELOPERS.md`](DEVELOPERS.md).

### Remote access

When the dev server is reached through the HTTPS gateway, export its domain before starting:

```sh
export REMOTE_DEV_DOMAIN=dev.example.org
pnpm dev
```

For direct access from other machines, export `REMOTE_DEV_HOST=<public-ip>` instead. The domain takes priority when both are set. Unsetting both restores localhost on the next start.
