# Project workspace setup

The setup phase of a working session: get the workspace ready before handling the user's request. You're in a thread session, so your plain-text replies are your delivery — but only the message that **ends your turn** is guaranteed to post; mid-turn lines may never leave the transcript. The message you end the setup turn with must carry everything the user needs: the `[WORKSPACE]` banner (Step 4) and what you did or launched. Never call `message` `send`/`thread-reply` targeting your own thread: it posts everything twice.

## Prerequisites — run both now, before Step 1

- `alcode --openclaw-guide` (`exec`) — the delegation manual. Required every time you run this procedure, status requests included; do not skip it because no coding seems planned.
- read `{PROJECT_PATH}/DEVELOPERS.md` — how to create a worktree or a branch.

## Step 1 — Requirements

You need:

- **PROJECT** — The main-worktree directory name shown to the user.
- **PROJECT_PATH** — The canonical absolute main-worktree path recorded in the thread starter.
- **TICKET_ID** — The external ticket ID or the side ticket `side-N` reserved by the working session.

If PROJECT, PROJECT_PATH, or TICKET_ID is missing, do not proceed. Do not guess or reconstruct these values. Ask the user.

## Step 2 — Post the setup signal

Setting up a workspace takes a while, so tell the user it started before you start it. One short line, in their language, and nothing else — the thread's starter already states the known project, ticket and task, so restating them here just repeats a message they can see.

Vary the wording: "Je prépare le workspace", "Setting up the workspace", "Spinning up the environment", "Getting the worktree ready", "Preparing the branch". No questions, no waiting.

On some surfaces this line never posts (mid-turn text — see the delivery note at the top). Write it anyway, and count on the end-of-turn message, not on it, for anything the user must see.

When the task changed with the message that woke you — a ticket that just arrived in a conversation thread, a scope the user just corrected — add a one-line restatement of what you're now working on. That line is the thread's durable record of the new task, the way the starter was for the original one.

## Step 3 — Name the thread (Discord-only)

Rename the thread whenever its name doesn't match what you now know. Format: `<TICKET_ID> - <PROJECT> - <1-to-5-word description>`, the description covering the task. A ticket that just arrived, a project that was unknown when the thread opened, a task that turned out to be something else — each one calls for the rename.

Discord renames a thread through a post, so make the setup signal carry it: send that line with `message` `action: "thread-reply"`, passing the thread's `threadId`, the new name as `threadName`, and the line itself as `message`. Then don't also write the line as plain text — that posts it twice.

That single call is the whole exception. The post right after it, and every one that follows, is plain text again; with nothing to rename, the tool never targets your own thread.

## Step 4 — Set up the project workspace (worktree, branch, dev server)

The workspace tooling owns worktrees. Run its main-worktree commands from PROJECT_PATH. Create, reuse, and tear worktrees down through its commands only — never `git worktree add`/`remove`/`prune`, never `rm -rf` on a worktree directory, never a branch checked out by hand outside a workspace. A worktree the tooling doesn't know about is invisible to every other session.

A project whose `DEVELOPERS.md` has no workspaces section is not set up for you. Stop there and tell the user the project needs the workspace system installed, offering to run the setup with the `alignfirst-setup-guide` skill.

First, check what already exists for the {TICKET_ID} — two checks, both required:

- **Branch**: from PROJECT_PATH, list the branches, local and remote (`git branch -a`), and look for one matching the {TICKET_ID}. No match means no branch yet — an answer, not a failure.
- **Registered workspaces**: `DEVELOPERS.md` names the project's guide command (`workspace --guide`, with the project's own runner). It gives the commands to **list registered workspaces** and to **set up a workspace** — on an existing branch, or on a new one. Use them.

Never assume the branch is new; `git worktree list` alone does not answer the branch question.

Whenever a branch exists, you work from its workspace — a status request included. "Status" means: set up the workspace, report its state (the banner below), sync the branch (Step 5), then report the work content (Step 6) — never `git log` from the main dir. Pick one sub-path:

1. **Branch + workspace already registered** → use it (no setup needed).
2. **Branch exists (local or remote), no workspace** → set up a workspace on the existing branch (don't create a new branch).
3. **No branch** → new-work intent: in PROJECT_PATH, pull the base branch (`git fetch` + fast-forward) so the new branch starts from the latest base, then set up a workspace on a new branch. Name it `{TICKET_ID}/{1-3-words}`, deriving the short description from the request. A pull that brought in new commits leaves the main worktree stale, and no later step refreshes it: once the workspace is up, run the "Refreshing the workspace after a branch refresh" flow on the main worktree at PROJECT_PATH. Status request with no branch: nothing exists yet — tell the user there's no work for this ticket, end turn.

The moment you have the linked workspace path — attached (sub-path 1) or freshly set up (2, 3) — post the `[WORKSPACE]` banner, before any `git` inspection or prose, and **include it again in the message you end the turn with**: the early post may not deliver on every surface, the final message always does (on Discord the Step 3 rename post also delivers). `workspace setup` blocks until the bootstrap reaches `ready` or `failed`; run it in the foreground (no `background` option) and report the state it returns. Run subsequent Git commands and `alcode` from that linked workspace, never PROJECT_PATH.

Bold the values with your surface's markers rather than literal `**`, and translate the labels to the user's language:

```text
[WORKSPACE] **{PROJECT}** — Ticket: `{TICKET_ID}`

Worktree: `{dirname}`
Branch: `{branch}`
Status: {running | ready | failed}
```

The lines below the tag report the workspace: after `Status:`, add what the setup output gives that the user can act on.

## Step 5 — Sync an existing branch on takeover (sub-paths 1 & 2)

Skip on sub-path 3 (no branch — nothing to sync). Otherwise, once the workspace is set up, bring the branch up to date *before* inspecting, working, or reporting a status — a teammate may have pushed since you last synced, and a report off a stale branch is wrong. In order:

1. **Confirm the branch.** Check the worktree's checked-out branch carries the expected TICKET_ID. If it doesn't, stop and surface it to the user — don't work on the wrong branch.
2. **Guard uncommitted work.** Run `git status`. If the worktree is dirty, have alcode commit a WIP first (even if it doesn't compile) — never sync over uncommitted work.
3. **Fetch.** `git fetch`.
4. **Merge the remote branch.** If the branch has a remote counterpart, merge it into the local branch to catch up. Delegate to alcode (`merge` protocol) when it doesn't fast-forward or conflicts.
5. **Catch up with the base branch.** If the freshly-fetched base branch (`origin/<base>`) has commits not yet in this branch, run the "Updating a branch with the base branch" flow — without asking; step 8 tells the user what came in.
6. **Refresh the workspace if commits came in.** If the merge brought in new commits, run the "Refreshing the workspace after a branch refresh" flow: reinstall dependencies, rebuild, run the new migrations.
7. **Check for an open MR/PR** on this branch and note its state.
8. **Report what changed.** If the fetch/merge pulled in new commits (remote or base), post a one-line summary so the user knows the ground shifted.

## Step 6 — Status request: the work content

Only for a status request; otherwise skip to Step 7. The Step 4 banner comes first — post it before delegating; by now the Step 5 sync has brought the branch current, so the report reflects the latest state.

The `[WORKSPACE]` banner answers "is the env ready", not "where does the work stand". For the work content — what was done, what remains — draw on two complementary sources:

- **Repo/workflow metadata**, which you may gather directly: `git log`/`status`/branch state, `gh` PR/issue state, the `.plans/` listing.
- **The ticket's AlignFirst artifacts** via `alcode` (`catchup` protocol, run from the worktree): it loads the ticket's `*spec.md` / `*summary.md` local files in the agent's session and returns a synthesis of them.

Combine them into the report and post it in the thread; lean on the `catchup` protocol whenever the spec/summary history matters. What you must **not** do is browse the source to describe how the code works — that's a delegation to alcode, not part of a status report.

## Step 7 — Start the work

The workspace is ready, so get to it: announce what you're about to do in one line, then do it. The user's request is the go-ahead; asking them to confirm it again wastes a turn.

Ask only when you genuinely can't proceed — the request is ambiguous enough that two readings lead to different work, or it turns on a product decision that isn't yours to make.
