# Developing

A small full-stack product monorepo (API + frontend).

## Stack

Node.js (≥22), pnpm, [Express 5](https://expressjs.com/). Entrypoint `app.mjs`. No DB, no cloud, no build step.

## Layout

- [`app.mjs`](app.mjs) — Express server. Reads its port from the `PORT` env var or from `local.env` (written per workspace by `pnpm workspace setup`), serves the home page on `/` and the CSV export on `/export`.
- [`home-page.mjs`](home-page.mjs) — the HTML: region links and the export button.
- [`comparables.mjs`](comparables.mjs) — the in-memory datastore, one row set per region.
- [`export-handler.mjs`](export-handler.mjs) — `GET /export?region=…`, rendering the rows as CSV.
- [`app.test.mjs`](app.test.mjs) — the test suite (`node:test`).

## Daily Commands

```sh
pnpm dev up     # start in background; `pnpm dev down` to stop
pnpm dev down   # stop the background server in this worktree
pnpm dev        # start the app (foreground; CTRL+C to stop)
pnpm test       # run the test suite
pnpm lint       # syntax-check every module
```

## Workspaces (local environments)

A **workspace** is a git worktree (with its branch) together with its own dev setup: dedicated ports, config files, a database, and a dev server you can bring up or down. Workspaces are isolated from one another, so you can run several branches in parallel.

Run `pnpm workspace --guide` for the full procedures (creating/removing workspaces, starting/stopping the dev server).

### Fresh Clone

```sh
pnpm i
pnpm workspace setup
```

## Conventions

- **Ticket ID:** `ABC-###` (`TEC-###`, etc.).
- **Branch:** `<ticket-id>/<type>` — e.g. `ABC-123/feat`, `ABC-456/fix`, `TEC-15/refactor`.
- **Commit:** conventional, bracketed ticket — `feat: [ABC-1234] short description`.
- **Base branch:** `main`. Most PRs target `main`.
- **Production branch:** `production`. Hotfixes go directly to `production`.

## Documentation

All technical documentation lives under `docs/` and is browsable via docmap:

```sh
npm run docmap
```

## Layout Quirks

- `.local-wt/` — per-worktree. Dev-server logs, setup log.
- `.local/` — symlinked across worktrees. Shared gitignored files (workspace registry, dev-server registry, personal notes).
- `.plans/` — symlinked across worktrees. AlignFirst task plans.
