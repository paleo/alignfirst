# Project workspace setup

Do NOT try to handle the user's request here. We need to set up the project workspace first, then hand off to a thread session where the actual work happens. This file covers the setup phase.

## Prerequisites

- load the `alignfirst-coaching` skill — how to delegate to the coding agent.
- read `~/projects/{PROJECT_NAME}/docs/welcome.md` — how to create a worktree or a branch.

## Step 1 — Requirements

You need:

- **PROJECT_NAME** — The directory name of the project under `~/projects/`
- **TICKET_ID** — An identifier for the work, ideally (but not necessarily) a ticket ID from the user's tracking system.
- **WORK_TYPE** for your branch name — a Conventional Commits prefix (`feat`, `fix`, `refactor`, `chore`, `docs`, …).

If you don't have the PROJECT_NAME or TICKET_ID, do not proceed. Do not guess these values. Ask the user.

If you have a clear reason to infer the WORK_TYPE, do so. Otherwise, don't guess — ask the user.

The branch name will be: `{TICKET_ID}/{WORK_TYPE}`.

## Step 2 — Acknowledge

Post one short message in the thread:

> Project **{PROJECT_NAME}**, ticket **{TICKET_ID}**. {setup signal}.

Translate to the user's language. Vary the setup signal — e.g. "Setting up the workspace", "Spinning up the environment", "Getting the worktree ready", "Preparing the branch". No questions, no waiting.

## Step 3 — Fix the thread name if needed (Discord-only)

If the thread name is missing the TICKET_ID or the PROJECT_NAME, rename it. Format: `<TICKET_ID> - <PROJECT> - <1-to-5-word description>`.

## Step 4 — Set up the project workspace (worktree, branch, dev server)

Before creating anything, check what already exists for `{TICKET_ID}/{WORK_TYPE}`. The project's `docs/workspace.md` (linked from `docs/welcome.md`) lists the commands to **list registered workspaces** and to **attach a workspace to an existing branch**. Use them — never assume the branch is new.

Three sub-paths, in order. Pick exactly one. The setup command always runs *before* any per-ticket inspection (`git log`, `git diff`, `git status`, …) — the worktree is what you inspect.

1. **Branch + worktree already registered** → attach to the existing workspace (no creation). Post the status report below.
2. **Branch exists (locally or remote) but no registered worktree** → run the project's *attach-existing-branch* command from its workspace doc. This sets up a worktree on the existing branch and is mandatory before any further inspection — `git log <branch>` from the main project dir is not a substitute. Post the status report.
3. **Neither exists** → if the user signalled a *new* work intent, pull the base branch first (`git fetch` + fast-forward) so the new branch starts from the latest base, then create both. If the user asked for a *status update* and there's no branch yet, do not create anything — tell the user there's no work for that ticket and end turn.

The path that does create (sub-paths 2 and 3) spawns background bootstrap — don't add your own `background` option. As soon as the setup command returns, post a status-only message with these three labelled fields (translated to the user's language):

```text
Worktree: {dirname}
Branch: {TICKET_ID}/{WORK_TYPE}
Bootstrap: {running | ready | failed}
```

### Sync an existing branch on takeover (sub-paths 1 & 2)

Once the worktree is attached, bring the branch up to date *before* inspecting or working. In order:

1. **Confirm the branch.** Check the worktree's checked-out branch carries the expected TICKET_ID. If it doesn't, stop and surface it to the user — don't work on the wrong branch.
2. **Guard uncommitted work.** Run `git status`. If the worktree is dirty, have the coding agent commit a WIP first (even if it doesn't compile) — never sync over uncommitted work.
3. **Fetch.** `git fetch`.
4. **Merge the remote branch.** If the branch has a remote counterpart, merge it into the local branch to catch up. Delegate to the coding agent (`merge` protocol) when it doesn't fast-forward or conflicts.
5. **Check the base branch.** If the freshly-fetched base branch (`origin/<base>`) has commits not yet in this branch, the branch is behind the base. Ask the user whether to merge the base in. On yes, run the "Updating a branch with the base branch" flow from [`working-session.md`](./working-session.md).
6. **Check for an open MR/PR** on this branch and note its state.
7. **Report what changed.** If the fetch/merge pulled in new commits (remote or base), post a one-line summary so the user knows the ground shifted.

## Step 5 — User's turn

When everything is ready:

- If you already know what to do, announce what you plan to do. Then ask the user for validation before doing anything.
- If something is unclear, ask the user what to do next.
