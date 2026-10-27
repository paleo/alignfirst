# Developer Guide

## Stack

Node.js (≥22), pnpm, [Express 5](https://expressjs.com/). Entrypoint `app.mjs`. No DB, no cloud, no build step.

## Layout

- [`app.mjs`](app.mjs) — Express server. Reads its port from the `PORT` env var or from `local.env` (written per workspace by `pnpm dev` or `pnpm dev setup`), serves the home page on `/` and the CSV export on `/export`.
- [`home-page.mjs`](home-page.mjs) — the HTML: region links and the export button.
- [`comparables.mjs`](comparables.mjs) — the in-memory datastore, one row set per region.
- [`export-handler.mjs`](export-handler.mjs) — `GET /export?region=…`, rendering the rows as CSV.
- [`app.test.mjs`](app.test.mjs) — the test suite (`node:test`).

## Daily Commands

```sh
alignfirst dev up     # start in background
alignfirst dev down   # stop the background server in this worktree
alignfirst dev        # start the app (foreground; CTRL+C to stop)
pnpm test       # run the test suite
pnpm lint       # syntax-check every module
```

## Workspaces (local environments)

A **workspace** is a git worktree (with its branch) together with its own dev setup: dedicated ports, config files and a dev server you can bring up or down. Ports and run files arrive with the first `pnpm dev` or `pnpm dev setup`; workspace setup alone stays portless. Workspaces are isolated, so you can run several branches in parallel.

Run `alignfirst workspace --guide` for the full procedures. The test harness supplies the built checkout CLI on PATH. `alignfirst-workspace.json` owns the recipe; project scripts consume its JSON ABI. Prepare ignored `.plans/` and `.local-wt/` before setup; setup never provisions missing work files.

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

- `.local-wt/` — per-worktree logs and runtime files. Its `workspace-registry/` is shared across worktrees.
- `.local/` — symlinked across worktrees. Shared gitignored personal notes.
- `.plans/` — symlinked across worktrees. AlignFirst work files.
