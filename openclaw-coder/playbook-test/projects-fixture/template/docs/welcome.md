---
title: Welcome
summary: Entry point for new developers.
---

# Welcome

A small full-stack product monorepo (API + frontend).

## Stack

Node.js (≥22), pnpm, [Express 5](https://expressjs.com/). Single entrypoint `app.mjs`. No DB, no cloud.

## Layout

- [`app.mjs`](app.mjs) — Express server. Reads `PORT` from env, serves `Hello world from <branch>` on `/`.

## Daily Commands

```sh
pnpm dev:up               # start the app (background)
pnpm dev:down             # stop it
```

## Workspaces (local environments)

A **workspace** is a git worktree (with its branch) together with its own dev setup: dedicated ports, config files, a database, and a dev server you can bring up or down. Workspaces are isolated from one another, so you can run several branches in parallel.

Read when relevant:

- [`docs/workspace.md`](docs/workspace.md) — Creating/removing workspaces, starting/stopping the dev server.

### Fresh Clone

```sh
pnpm i
pnpm workspace setup --wait
```

## Conventions

- **Ticket ID:** `ABC-###` (`TEC-###`, etc.).
- **Branch:** `<ticket-id>/<type>` — e.g. `ABC-123/feat`, `ABC-456/fix`, `TEC-15/refactor`.
- **Commit:** conventional, bracketed ticket — `feat: [ABC-1234] short description`.
- **Base branch:** `develop`. Most PRs target `develop`.
- **Production branch:** `main`. Hotfixes go directly to `main`.

## Documentation

```sh
pnpm docmap                  # browse the table of contents
pnpm docmap --recursive      # view the full tree
pnpm docmap docs/workspace.md
```

## Layout Quirks

- `.local/` — symlinked across worktrees. Shared gitignored files (slot registry, dev-server registry, personal notes).
- `.local-wt/` — per-worktree. Dev-server logs, setup log.
- `.plans/` — symlinked across worktrees. AlignFirst task plans.

Always exclude `.local/`, `.local-wt/`, and `.plans/` from codebase searches.
