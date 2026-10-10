# Developer Guide

This repository holds the configuration of `{{SERVER_HOST}}`: runbooks under `docs/installations/`, operations under `docs/operations/`, and the OpenClaw seed, workspace files and scripts under `infra/openclaw/`. No application code, no build, no test suite.

## Layout

- `docs/` — runbooks and notes, listed by `npx -y alignfirst docmap`.
- `infra/openclaw/` — `seed.sh` and its modules, `environment.d/`, `bin/`, `projects/`, `workspace/`, `coding-agent/`. `.env` is gitignored.
- `scripts/workspace/` — the portless workspace wrapper.
- `.reports/` — one journal per operator task, committed.
<!-- TEAM_PLANS_SECTION -->
- `.plans/` — work files. Symlinked across worktrees, and into a clone of the work-files repository so the team shares them. Run `npx -y alignfirst sync` after changing anything under it.
<!-- TEAM_PLANS_SECTION -->
- `.local/`, `.local-wt/` — shared notes and per-worktree state, gitignored.

## Workspaces

A **workspace** is a git worktree (with its branch) plus its own dev setup: symlinked shared directories and seeded config files. This repository is portless: nothing to start, no `dev` script.

Run `npm run workspace -- --guide` for the procedures.

## Everyday commands

| Command | Purpose |
| --- | --- |
| `npx -y alignfirst context` | Conventions, documentation index and protocols; read it first |
| `npx -y alignfirst docmap` | Browse the documentation |
| `npm run workspace -- <command>` | Manage worktree workspaces (`--guide` for the procedures) |
| `npm run validate` | docmap check and a syntax check of the wrapper |
<!-- TEAM_PLANS_SECTION -->
| `npx -y alignfirst sync` | Publish and retrieve the work files (`.plans`) |
<!-- TEAM_PLANS_SECTION -->
