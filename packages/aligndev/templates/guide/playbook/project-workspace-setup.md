# Runbook: Project workspace setup

{{#openclaw}}
The setup phase of a working session: get the workspace ready before handling the user's request. You're in a thread session, so your plain-text replies are your delivery — but only the message that **ends your turn** is guaranteed to post; mid-turn lines may never leave the transcript. The message you end the setup turn with must carry everything the user needs: the `[WORKSPACE]` banner (Step 4) and what you did or launched. Never call `message` `send`/`thread-reply` targeting your own thread: it posts everything twice.
{{/openclaw}}
{{#codingAgent}}
The setup phase of a working session: decide the workplace and get it ready before handling the user's request. The message you end the setup turn with carries the `[WORKSPACE]` banner (Step 4) and what you did or launched, or the question Step 2 or Step 5 asks the user.
{{/codingAgent}}

{{#openclaw}}
## Prerequisites — run both now, before Step 1
{{/openclaw}}
{{#codingAgent}}
## Prerequisites — before Step 1
{{/codingAgent}}

{{#openclaw}}
- `{{ALIGNDEV}} guide code` (`exec`) — the delegation manual. Required every time you run this procedure, status requests included; do not skip it because no coding seems planned.
{{/openclaw}}
{{#codingAgent}}
- `{{ALIGNDEV}} guide code` — the delegation manual. Required every time you run this procedure, status requests included; do not skip it because no coding seems planned.
{{/codingAgent}}
{{#openclaw}}
- run `{{ALIGNDEV}} project status <PROJECT_PATH>` and retain its `DEVELOPERS.md` path as DEVELOPERS_PATH, then read that file when it exists — how to create a worktree or a branch.
{{/openclaw}}
{{#codingAgent}}
{{#hasGuide}}
- Read DEVELOPERS_PATH, retained by Step 1 of `{{ALIGNDEV}} guide working-session` — whether the project has workspace tooling, and how to create a worktree or a branch.
{{/hasGuide}}
{{/codingAgent}}

## Step 1 — Requirements

You need:

- **PROJECT** — The main-worktree directory name shown to the user.
{{#openclaw}}
- **PROJECT_PATH** — The canonical absolute main-worktree path recorded in the thread starter.
{{/openclaw}}
{{#codingAgent}}
- **PROJECT_PATH** — The canonical absolute main-worktree path resolved by Step 1 of `{{ALIGNDEV}} guide working-session`.
- **The workplace and the default branch** — The session's worktree, its branch, and the project's default branch, retained by the same step.
{{/codingAgent}}
- **TICKET_ID** — The external ticket ID or the side ticket `side-N` reserved by the working session.

If PROJECT, PROJECT_PATH, or TICKET_ID is missing, do not proceed. Do not guess or reconstruct these values. Ask the user.

{{#openclaw}}
## Step 2 — Post the setup signal

Setting up a workspace takes a while, so tell the user it started before you start it. One short line, in their language, and nothing else — the thread's starter already states the known project, ticket and task, so restating them here just repeats a message they can see.
{{/openclaw}}
{{#codingAgent}}
## Step 2 — Decide the workplace

{{#hasGuide}}
The project has **workspace tooling** when DEVELOPERS_PATH describes workspaces.
{{/hasGuide}}
{{#noGuide}}
The project has no **workspace tooling**.
{{/noGuide}}

The workplace is the first case that matches:

1. **The user's request or instructions name the place** — a directory, a branch, a workspace: work there.
2. **The session's branch carries TICKET_ID** — work in place. Skip Steps 3 and 4: post the `[WORKSPACE]` banner (format in Step 4) with the session's worktree and branch and `Status: ready`, then go to Step 5.
3. **The session's branch is long-lived** — the default branch, or a name such as `main`, `master`, `develop`, `release` or `production`: open or create the ticket's workspace in Step 4, without asking.
4. **Any other branch**, one carrying another ticket's ID included — end the turn on one message asking where to work. On the answer, "here" means the session's worktree as it is, handled as in case 2; a branch or a directory the user names falls under case 1.

Without workspace tooling, case 3 also ends the turn on that question, and "here" means the ticket's branch in the session's worktree: `git switch <branch>` when it exists, else a fast-forward of the base branch, then `git switch -c {TICKET_ID}/{1-3-words}`. The banner then follows case 2.

## Step 3 — Post the setup signal

Post the signal only when Step 2 opens or creates a workspace.

Setting up a workspace takes a while, so tell the user it started before you start it. One short line, in their language, and nothing else — the user already knows the project, ticket and task, so restating them here just repeats what they have seen.
{{/codingAgent}}

Vary the wording: "Je prépare le workspace", "Setting up the workspace", "Spinning up the environment", "Getting the worktree ready", "Preparing the branch". No questions, no waiting.

{{#openclaw}}
On some surfaces this line never posts (mid-turn text — see the delivery note at the top). Write it anyway, and count on the end-of-turn message, not on it, for anything the user must see.
{{/openclaw}}

{{#openclaw}}
When the task changed with the message that woke you — a ticket that just arrived in a conversation thread, a scope the user just corrected — add a one-line restatement of what you're now working on. That line is the thread's durable record of the new task, the way the starter was for the original one.
{{/openclaw}}
{{#codingAgent}}
When the task changed with the user's latest message — a ticket that just arrived, a scope the user just corrected — add a one-line restatement of what you're now working on. That line is the conversation's record of the new task.
{{/codingAgent}}

{{#openclaw}}
## Step 3 — Name the thread (Discord-only)

Rename the thread whenever its name doesn't match what you now know. Format: `<TICKET_ID> - <PROJECT> - <1-to-5-word description>`, the description covering the task. A ticket that just arrived, a project that was unknown when the thread opened, a task that turned out to be something else — each one calls for the rename.

Discord renames a thread through a post, so make the setup signal carry it: send that line with `message` `action: "send"`, passing the current thread's complete `chat_id` as `target`, the new name as `threadName`, and the line itself as `message`. Don't also write the line as plain text; that posts it twice. The post does not end the turn: Step 4 follows in the same turn, and the turn ends on the banner.

That single call is the whole exception. The post right after it, and every one that follows, is plain text again; with nothing to rename, the tool never targets your own thread.
{{/openclaw}}

{{#openclaw}}
## Step 4 — Set up the project workspace (worktree, branch, dev server)
{{/openclaw}}
{{#codingAgent}}
## Step 4 — Set up the workspace (worktree, branch, dev server)
{{/codingAgent}}

{{#openclaw}}
A project runs in **main-worktree mode** when DEVELOPERS_PATH is missing or has no workspaces section. Its main worktree at PROJECT_PATH is its only workspace, used by one working thread at a time. "Main-worktree mode" below adapts this step, and wherever the playbook names the linked workspace, you use PROJECT_PATH.
{{/openclaw}}

{{#openclaw}}
Otherwise, the workspace tooling owns worktrees. Run its main-worktree commands from PROJECT_PATH. Create, reuse, and tear worktrees down through its commands only — never `git worktree add`/`remove`/`prune`, never `rm -rf` on a worktree directory, never a branch checked out by hand outside a workspace. A worktree the tooling doesn't know about is invisible to every other session.
{{/openclaw}}
{{#codingAgent}}
The workspace tooling owns worktrees. Run its main-worktree commands from PROJECT_PATH. Create, reuse, and tear worktrees down through its commands only — never `git worktree add`/`remove`/`prune`, never `rm -rf` on a worktree directory, never a branch checked out by hand outside a workspace. A worktree the tooling doesn't know about is invisible to every other session.
{{/codingAgent}}

First, fetch remote refs from PROJECT_PATH with `git fetch --prune`. Then check what already exists for the {TICKET_ID} — two checks, both required:

- **Branch**: from PROJECT_PATH, list the branches, local and remote (`git branch -a`), and look for one matching the {TICKET_ID}. No match means no branch yet — an answer, not a failure.
{{#openclaw}}
- **Registered workspaces**: `DEVELOPERS.md` names the project's guide command (`workspace --guide`, with the project's own runner). It gives the commands to **list registered workspaces** and to **set up a workspace** — on an existing branch, or on a new one. Use them.
{{/openclaw}}
{{#codingAgent}}
- **Registered workspaces**: the workspace tooling's guide command (`workspace --guide`, with the project's own runner) gives the commands to **list registered workspaces** and to **set up a workspace** — on an existing branch, or on a new one. Use them.
{{/codingAgent}}

Never assume the branch is new; `git worktree list` alone does not answer the branch question.

Whenever a branch exists, you work from its workspace — a status request included. "Status" means: set up the workspace, report its state (the banner below), sync the branch (Step 5), then report the work content (Step 6) — never `git log` from the main dir. Pick one sub-path:

1. **Branch + workspace already registered** → use it (no setup needed).
2. **Branch exists (local or remote), no workspace** → set up a workspace on the existing branch (don't create a new branch).
3. **No branch** → for a status request, end the turn on a message reporting that no workspace or code work exists, with any request, spec, and summary files listed by the ticket preflight; create nothing. Any other request is new-work intent: in PROJECT_PATH, fast-forward the base branch from its freshly fetched remote ref so the new branch starts from the latest base, then set up a workspace on a new branch. Name it `{TICKET_ID}/{1-3-words}`, deriving the short description from the request. A fast-forward that brought in new commits leaves the main worktree stale, and no later step refreshes it: once the workspace is up, run the "Refreshing the workspace after a branch refresh" flow on the main worktree at PROJECT_PATH.

{{#openclaw}}
The moment you have the linked workspace path — attached (sub-path 1) or freshly set up (2, 3) — post the `[WORKSPACE]` banner, before any `git` inspection or prose, and **include it again in the message you end the turn with**: the early post may not deliver on every surface, the final message always does (on Discord the Step 3 rename post also delivers). `workspace setup` blocks until the bootstrap reaches `ready` or `failed`; run it in the foreground (no `background` option) and report the state it returns. Run subsequent Git commands and `{{ALIGNDEV}} code` from that linked workspace, never PROJECT_PATH, except in main-worktree mode.
{{/openclaw}}
{{#codingAgent}}
The moment you have the workplace — in place, attached (sub-path 1) or freshly set up (2, 3) — post the `[WORKSPACE]` banner, before any `git` inspection or prose. `workspace setup` blocks until the bootstrap reaches `ready` or `failed`; run it in the foreground and report the state it returns. Run subsequent Git commands and `{{ALIGNDEV}} code` from the workplace.
{{/codingAgent}}

{{#openclaw}}
Bold the values with your surface's markers rather than literal `**`, and translate the labels to the user's language:
{{/openclaw}}
{{#codingAgent}}
Bold the values in Markdown, and translate the labels to the user's language:
{{/codingAgent}}

```text
[WORKSPACE] **{PROJECT}** — Ticket: `{TICKET_ID}`

Worktree: `{dirname}`
Branch: `{branch}`
Status: {running | ready | failed}
```

The lines below the tag report the workspace: after `Status:`, add what the setup output gives that the user can act on.

{{#openclaw}}
### Main-worktree mode
{{/openclaw}}

{{#openclaw}}
The branch check applies; the registered-workspace check does not. Before any checkout, claim the main worktree. It is free when it is on the default branch with a clean `git status`, or already on this thread's {TICKET_ID} branch. Otherwise, end the turn telling the user the project is busy: name the checked-out branch and the uncommitted changes, and change nothing.
{{/openclaw}}

{{#openclaw}}
On a free main worktree, the sub-paths above run in PROJECT_PATH with plain `git switch`:

1. **Already on the branch** → use it.
2. **Branch exists, not checked out** → `git switch <branch>`.
3. **No branch** → a status request ends as above. Otherwise, fast-forward the base branch as above, then `git switch -c {TICKET_ID}/{1-3-words}`.

The `[WORKSPACE]` banner names the main worktree: `Worktree:` is the directory name of PROJECT_PATH, and `Status:` is `ready`.
{{/openclaw}}

{{#openclaw}}
## Step 5 — Sync an existing branch on takeover (sub-paths 1 & 2)
{{/openclaw}}
{{#codingAgent}}
## Step 5 — Sync an existing branch
{{/codingAgent}}

{{#codingAgent}}
In place on an existing branch, fetch first. A fast-forward of the branch onto its remote counterpart or onto the base branch, on a clean tree, is the only sync done without asking: do it, then report it in one line. Anything else — uncommitted changes, a remote branch that does not fast-forward, a base-branch catch-up that needs a merge commit — ends the turn on one message stating what will happen ("I'll commit your changes as WIP and merge `main`, OK?"). The list below runs on the user's yes. In a workspace you opened or created, the list runs directly.
{{/codingAgent}}

Skip on sub-path 3 (no branch — nothing to sync). Otherwise, once the workspace is set up, bring the branch up to date *before* inspecting, working, or reporting a status — a teammate may have pushed since you last synced, and a report off a stale branch is wrong. In order:

1. **Confirm the branch.** Check the worktree's checked-out branch carries the expected TICKET_ID. If it doesn't, stop and surface it to the user — don't work on the wrong branch.
2. **Guard uncommitted work.** Run `git status`. If the worktree is dirty, have the agent commit a WIP first (even if it doesn't compile) — never sync over uncommitted work.
3. **Merge the remote branch.** If the branch has a remote counterpart, merge its freshly fetched ref into the local branch to catch up. Delegate to the agent (`merge` protocol) when it doesn't fast-forward or conflicts.
4. **Catch up with the base branch.** If the freshly fetched base branch (`origin/<base>`) has commits not yet in this branch, run the "Updating a branch with the base branch" flow — without asking; step 7 tells the user what came in.
5. **Refresh the workspace if commits came in.** If the merge brought in new commits, run the "Refreshing the workspace after a branch refresh" flow: reinstall dependencies, rebuild, run the new migrations.
6. **Check for an open MR/PR** on this branch and note its state.
7. **Report what changed.** If either merge brought in new commits, post a one-line summary so the user knows the ground shifted.

## Step 6 — Status request: the work content

Only for a status request; otherwise skip to Step 7. The Step 4 banner comes first — post it before delegating; by now the Step 5 sync has brought the branch current, so the report reflects the latest state.

The `[WORKSPACE]` banner answers "is the env ready", not "where does the work stand". For the work content — what was done, what remains — draw on two complementary sources:

- **Repo/workflow metadata**, which you may gather directly: `git log`/`status`/branch state, `gh` PR/issue state, the `.plans/` listing.
- **The ticket's AlignFirst artifacts** via `{{ALIGNDEV}} code new --ticket <id> --catchup`, run from the worktree: the agent loads the ticket history and returns a synthesis.

{{#openclaw}}
Combine them into the report and post it in the thread; use `--catchup` whenever the ticket history matters. Add `--protocol aad` or `--protocol spec` to continue with that protocol in the same `{{ALIGNDEV}} code` call. What you must **not** do is browse the source to describe how the code works — that's a delegation to the agent, not part of a status report.
{{/openclaw}}
{{#codingAgent}}
Combine them into the report and post it in the conversation; use `--catchup` whenever the ticket history matters. Add `--protocol aad` or `--protocol spec` to continue with that protocol in the same `{{ALIGNDEV}} code` call. What you must **not** do is browse the source to describe how the code works — that's a delegation to the agent, not part of a status report.
{{/codingAgent}}

## Step 7 — Start the work

{{#openclaw}}
The workspace is ready. Before a coding delegation, apply the takeover-turn race checkpoint in the playbook (`{{ALIGNDEV}} guide`). Then announce what you're about to do in one line and do it. The user's request is the go-ahead; asking them to confirm it again wastes a turn.
{{/openclaw}}
{{#codingAgent}}
The workspace is ready. Announce what you're about to do in one line and do it. The user's request is the go-ahead; asking them to confirm it again wastes a turn.
{{/codingAgent}}

{{#openclaw}}
When the work is an `{{ALIGNDEV}} code` run, launch it as the delegation guide describes: background `exec` with `timeoutSeconds: 0`, then end the turn on the acknowledgement. Call nothing on the `{{ALIGNDEV}} code` session before the chained turn wakes you, whatever the `exec` acknowledgement suggests.
{{/openclaw}}
{{#codingAgent}}
When the work is an `{{ALIGNDEV}} code` run, launch it in the background as the delegation guide describes, then end the turn on the acknowledgement.
{{/codingAgent}}

Ask only when you genuinely can't proceed — the request is ambiguous enough that two readings lead to different work, or it turns on a product decision that isn't yours to make.
