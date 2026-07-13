# Project workspace setup

Do NOT try to handle the user's request here. We need to set up the project workspace first, then hand off to a thread session where the actual work happens. This file covers the setup phase.

Discord: every user-facing post during this procedure is a `message` call carrying the thread's `threadId` — free-form assistant text streams to the parent channel, not the thread. This includes the **final answer that ends the turn**: a status finding like "no branch — no work for this ticket yet" is still a `message` `thread-reply`, never plain prose. The turn's final answer is always exactly `NO_REPLY` — the user-facing content already went out through `message` calls. Keep observations and intermediate findings internal; post only the banner, the reports this file prescribes, and the final finding — each via `message`.

## Prerequisites — run both now, before Step 1

- `alcode --openclaw-guide` (`exec`) — the delegation manual. Required on every WORK turn, status requests included; do not skip it because no coding seems planned.
- read `~/projects/{PROJECT_NAME}/DEVELOPMENT.md` — how to create a worktree or a branch.

## Step 1 — Requirements

You need:

- **PROJECT_NAME** — The directory name of the project under `~/projects/`
- **TICKET_ID** — An identifier for the work, ideally (but not necessarily) a ticket ID from the user's tracking system.

If you don't have the PROJECT_NAME or TICKET_ID, do not proceed. Do not guess these values. Ask the user.

## Step 2 — Post the `[WORK]` header

The moment you enter WORK mode, your **first** user-facing post is this banner — before any other ack or prose. It's the thread's project/ticket source of truth:

> [WORK] Project: {PROJECT_NAME} — Ticket: {TICKET_ID} — Audience: {AUDIENCE}. {setup signal}
>
> Task: {one-line restatement of the task}

- `{AUDIENCE}` — `tech` / `non-tech`, carried forward from the starter (which already recorded it). If no starter recorded it yet, read the sender's `AUDIENCE` from `USER.md` — see "Who you're talking to" in the dispatcher skill.
- `{one-line restatement of the task}` — restate, in your own words, what the user asked for (e.g. "make the export button bold"). This is the thread's durable record of *what to do*: a later fresh thread session recovers the task from it, having never seen the channel message that stated it. Always include this line. When no task is defined yet (a bare ticket, no scope), write that it is still to be defined instead — never omit the line, never leave it blank.
- Bold the values — project, ticket, audience — with your surface's bold markers (not literal `**`). Put the task on its own line, after a line break.
- Multiple projects: join them with `+` (e.g. `proj-a+proj-b`).
- Keep `[WORK]` and the values (including the `tech`/`non-tech` token) intact; translate the setup signal and the task line to the user's language and vary the setup signal — "Setting up the workspace", "Spinning up the environment", "Getting the worktree ready", "Preparing the branch". No questions, no waiting.

## Step 3 — Fix the thread name if needed (Discord-only)

If the thread name is missing the TICKET_ID or the PROJECT_NAME, rename it. Format: `<TICKET_ID> - <PROJECT> - <1-to-5-word description>`.

## Step 4 — Set up the project workspace (worktree, branch, dev server)

First, check what already exists for the {TICKET_ID} — two checks, both required:

- **Branch**: list the branches, local and remote (`git branch -a`), and look for one matching the {TICKET_ID}. No match means no branch yet — an answer, not a failure.
- **Registered workspaces**: `DEVELOPMENT.md` points to the project's `workspace --guide` command, which gives the commands to **list registered workspaces** and to **set up a workspace** — on an existing branch, or on a new one. Use them.

Never assume the branch is new; `git worktree list` alone does not answer the branch question.

Whenever a branch exists, you work from its workspace — a status request included. "Status" means: set up the workspace, report its state (the block below), then report the work content (Step 5) — never `git log` from the main dir. Pick one sub-path:

1. **Branch + workspace already registered** → use it (no setup needed).
2. **Branch exists (local or remote), no workspace** → set up a workspace on the existing branch (don't create a new branch).
3. **No branch** → new-work intent: pull the base branch (`git fetch` + fast-forward) so the new branch starts from the latest base, then set up a workspace on a new branch. Name it `{TICKET_ID}/{1-3-words}`, deriving the short description from the request. Status request with no branch: nothing exists yet — tell the user there's no work for this ticket, end turn.

The moment you have the workspace — attached (sub-path 1) or freshly set up (2, 3) — your **first** post is this block, before any `git` inspection or prose. `workspace setup` blocks until the bootstrap reaches `ready` or `failed`; run it in the foreground (no `background` option) and report the state it returns. Inspect the workspace, never the main dir. In the user's language:

```text
Worktree: {dirname}
Branch: {branch}
Bootstrap: {running | ready | failed}
```

### Sync an existing branch on takeover (sub-paths 1 & 2)

Once the workspace is set up, bring the branch up to date *before* inspecting or working. In order:

1. **Confirm the branch.** Check the worktree's checked-out branch carries the expected TICKET_ID. If it doesn't, stop and surface it to the user — don't work on the wrong branch.
2. **Guard uncommitted work.** Run `git status`. If the worktree is dirty, have alcode commit a WIP first (even if it doesn't compile) — never sync over uncommitted work.
3. **Fetch.** `git fetch`.
4. **Merge the remote branch.** If the branch has a remote counterpart, merge it into the local branch to catch up. Delegate to alcode (`merge` protocol) when it doesn't fast-forward or conflicts.
5. **Check the base branch.** If the freshly-fetched base branch (`origin/<base>`) has commits not yet in this branch, the branch is behind the base. Ask the user whether to merge the base in. On yes, run the "Updating a branch with the base branch" flow from [`working-session.md`](./working-session.md).
6. **Reinstall deps (and rebuild) if commits came in.** If the merge brought in new commits, reinstall dependencies with the project's package manager, then rebuild if the project needs it. Delegate both to alcode.
7. **Check for an open MR/PR** on this branch and note its state.
8. **Report what changed.** If the fetch/merge pulled in new commits (remote or base), post a one-line summary so the user knows the ground shifted.

## Step 5 — Status request: the work content

Only for a status request; otherwise skip to Step 6. The Step 4 block comes first — post it before delegating.

The workspace block answers "is the env ready", not "where does the work stand". For the work content — what was done, what remains — delegate: `alcode`, `read` protocol, run from the worktree. Relay its answer in the thread. The sync output (`git status`, fetch) is for syncing only — never compose this report yourself from `git log`, `.plans/` reads, or code browsing.

## Step 6 — User's turn

When everything is ready:

- If you already know what to do, announce what you plan to do. Then ask the user for validation before doing anything.
- If something is unclear, ask the user what to do next.
