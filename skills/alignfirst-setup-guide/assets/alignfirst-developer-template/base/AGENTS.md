# Repository Instructions

Always ignore `.plans`, `.local`, `.local-wt`, `node_modules`, generated reports, runtime state, and
secret files when searching the repository.

## Work Boundaries

Use the installed `sysadmin` skill for infrastructure, service, security, package, account, or
runtime-configuration work.

Repository support work may inspect and edit version-controlled files and run local validation.
Server operator work must follow the relevant runbook, use its stated execution role, and stop when
the live host differs from the documented preconditions. Report the unexpected state to the human
operator before mutating the host.

Never read, print, copy, commit, or send secret values. Human operators own authentication and secret
entry.

## Docmap - Seek Documentation

*Before* any investigation or code exploration, run `npm run docmap`, then read the relevant
documentation. Mandatory for every task.

## AlignFirst - Ticket ID, Commit Message, Branch Name

_Ticket ID:_ Format is numeric. Use an explicitly provided ticket. Otherwise deduce it from the
current branch name, then `git branch --show-current`. Ask only as a last resort.

Use Conventional Commits without the ticket ID, such as `docs: update recovery procedure`.

Name branches `<ticket-id>/<1-3-words>`.

<!-- TEAM_PLANS_SECTION -->

## Workspaces

A workspace is a git worktree with shared `.plans` and `.local` directories, seeded gitignored files,
and per-worktree `.local-wt` state. This repository is portless and has no dev-server command.

Run `npm run workspace -- --guide` for the full procedures.

## Validation

Run `npm run validate` after changing repository source. For shell assets, also run `bash -n`; for
JSON, parse the file; for JavaScript, run `node --check`.
