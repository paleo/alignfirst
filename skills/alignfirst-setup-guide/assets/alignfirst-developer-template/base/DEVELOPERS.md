# Developer Guide

This repository holds the configuration of `{{SERVER_HOST}}`: runbooks under `docs/installations/`, operations under `docs/operations/`, and the OpenClaw seed, workspace files and scripts under `infra/openclaw/`. No application code, no build, no test suite.

## Layout

- `docs/` — runbooks and notes, listed by `alignfirst docmap`.
- `infra/openclaw/` — `seed.sh` and its modules, `environment.d/`, `bin/`, `projects/`, `workspace/`, `coding-agent/`. `.env` is gitignored.
- `scripts/workspace/` — the portless workspace wrapper.
- `.reports/` — one journal per operator task, committed.
<!-- TEAM_PLANS_SECTION -->
- `.plans/` — task plans. Symlinked across worktrees, and into a clone of the team plans repository so plans are shared with the team. Run `alignfirst sync` after changing anything under it.
<!-- TEAM_PLANS_SECTION -->
- `.local/`, `.local-wt/` — shared notes and per-worktree state, gitignored.

## Workspaces

A **workspace** is a git worktree (with its branch) plus its own dev setup: symlinked shared directories and seeded config files. This repository is portless: nothing to start, no `dev` script.

Run `npm run workspace -- --guide` for the procedures.

## Conventions

- _Commit messages_: Conventional Commits, very short subject, no ticket ID.
- _Default branch_: `main`.

## Everyday commands

| Command | Purpose |
| --- | --- |
| `alignfirst docmap` | Browse the documentation; read `docs/overview.md` first |
| `npm run workspace -- <command>` | Manage worktree workspaces (`--guide` for the procedures) |
| `npm run validate` | docmap check and a syntax check of the wrapper |
<!-- TEAM_PLANS_SECTION -->
| `alignfirst sync` | Publish and retrieve the task plans (`.plans`) |
<!-- TEAM_PLANS_SECTION -->
