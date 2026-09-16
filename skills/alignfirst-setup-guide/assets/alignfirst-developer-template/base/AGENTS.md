# Admin Repository of {{DEVELOPER_NAME}}

This repository documents and operates `{{SERVER_HOST}}`, the server that runs **{{DEVELOPER_NAME}}**, an AlignFirst Developer. Every configuration step is a runbook under `docs/installations/`, so the server can be rebuilt from scratch.

## Seek project conventions and documentation

Run `npx -y alignfirst context` from the repository root, _before_ any investigation or code exploration. It prints the project conventions, the documentation map, and the AlignFirst protocols.

## Sysadmin workflow

Follow the `sysadmin` skill: record steps as runbooks under `docs/`, keep a per-task `.reports/` journal, run commands carefully.

Two roles, keyed to where the session runs:

- **Support** — a session on a laptop: edits the repository, never executes on the server.
- **Operator** — a session in the admin account `{{SERVER_ADMIN_USER}}` on `{{SERVER_HOST}}` (`~/{{ADMIN_REPOSITORY_NAME}}`): edits and executes. The service account is `{{SERVICE_USER}}`, reached with `sudo -i -u {{SERVICE_USER}} -- <command>`.

Repository specifics:

- Runbooks match `docs/installations/01-server-setup.md`: one short line of prose, then a fenced code block.
- `.reports/` is committed.

## Workspaces

A **workspace** is a git worktree (with its branch) plus its own dev setup: symlinked shared directories and seeded config files. Workspaces are isolated, so you can work on several branches in parallel. This repository has no dev server, so the system runs portless: nothing to start, no `dev` script.

Run `npm run workspace -- --guide` for the full procedures.

## Writing OpenClaw workspace files

When editing a file under `infra/openclaw/workspace/` to fix an agent behavior, leave the text the same length or shorter. First understand why the surrounding passage exists, then rewrite it to express the new behavior without bloat.

## Coding rules

- UTF-8, 2-space indentation, 100-char line width.
- Semicolons; double quotes `"`.
