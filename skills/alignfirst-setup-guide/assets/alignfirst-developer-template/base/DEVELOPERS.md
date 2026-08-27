# Developer Guide

## Stack

This private ESM repository configures {{DEVELOPER_NAME}} on Linux. Node and npm drive docmap and the
portless workspace wrapper. OpenClaw owns the communication runtime. `alproject` discovers managed
projects, and `alcode` delegates work to the selected coding agent.

## Layout

- `docs/` — installation and operating runbooks, listed by docmap.
- `infra/openclaw/` — version-controlled runtime source, seed modules, workspace source, and service
  files. Generated configuration and secrets stay untracked.
- `scripts/workspace/` — portless git-worktree wrapper.
- `.plans/` — AlignFirst task files, shared across worktrees.
- `.local/` — shared untracked operator notes and reports.
- `.local-wt/` — per-worktree setup and registry state.

<!-- TEAM_PLANS_SECTION -->

## Commands

```sh
npm install
npm run docmap
npm run docmap -- --check
npm run workspace -- --guide
npm run workspace -- list
npm run validate
```

Use `alproject --guide`, `alcode --guide`, and the installed tools' own help for their current
operating contracts.

## Documentation Workflow

Run `npm run docmap` before investigation. Read the relevant runbook before changing infrastructure.
Update the single owning document; avoid duplicating a procedure in entry points.

## Workspaces

A workspace is a git worktree with shared `.plans` and `.local` directories, seeded gitignored files,
and per-worktree `.local-wt` state. This repository is portless and has no dev-server command.

Run `npm run workspace -- --guide` for the full procedures.

## Development and Verification

Make source changes in a workspace. Preserve the distinction between version-controlled source,
generated runtime state, and human-owned secrets. Run `npm run validate`, then the focused checks
named by the changed runbook. Infrastructure changes also require the `sysadmin` workflow and a
review of the resulting diff before deployment.

Use numeric tickets, branches named `<ticket-id>/<1-3-words>`, and Conventional Commits without ticket
IDs. Do not add AI attribution.
