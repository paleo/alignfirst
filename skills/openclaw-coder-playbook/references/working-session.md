# Working session

You're working on a ticket inside a thread (Slack or Discord). The thread is the user-facing surface; everything you post here is visible to the user.

Your plain-text replies stream into the thread natively — they **are** your delivery, on Discord and Slack alike. Never call `message` `send`/`thread-reply` targeting this thread: it posts everything twice. `message` stays for `read`, the thread rename, cross-surface posts, and attachments.

## Prerequisites

- run `alcode --openclaw-guide` (`exec`) and follow it — how to delegate to alcode.
- read `~/projects/{PROJECT_NAME}/DEVELOPMENT.md` — how to create a worktree or a branch.

## Take over a working session

### Step 1 — Recover thread context (fresh thread session)

Before any other tool call or reply, call `message` `action: "read"` with `channel` and `threadId` from your conversation metadata. Recover PROJECT, TICKET_ID, and the AUDIENCE from the thread: the `[WORK]` header carries all three; before it's posted, the starter names the project and records the audience, and the ticket comes from the user's messages. Never derive PROJECT or TICKET_ID from a ticket prefix or `ls ~/projects/`; recover the audience from the thread or the sender. Branch, worktree path, and dev-server URL also live in the history.

### Step 2 — Determine the mode: WORK or TALK?

- **WORK** — PROJECT and TICKET_ID are both known. Open [`project-workspace-setup.md`](./project-workspace-setup.md), read it fully, and complete its procedure *before any other action* — including before inspecting the codebase. Your first post is its `[WORK]` header (Step 2), before any other ack or prose — this holds on a fresh WORK thread **and** when promoting a TALK thread the moment a ticket arrives. The procedure handles the three cases (no branch, branch only, branch + worktree) uniformly. Skipping it and going straight to `git log` or `git branch` is a violation.
- **TALK** — PROJECT or TICKET_ID is missing. Skip the worktree and go to Step 3. If both become known later, promote to WORK (post the `[WORK]` header then).

### Step 3 — Handle the actual request

Use the guidelines.

## Guidelines

### Interpreting requests

Interpret every user message in the context of the current project — something to do, investigate, challenge, or advise on inside the codebase. The user is rarely asking you to perform the action _in the chat_; they're asking about the project.

- **Code change.** "Set this text bolder" → bold it in the project, not in the chat reply.

Only when the message is unambiguously about chat content ("summarize this thread", "what does this mean") should you treat it as a regular conversation.

**Investigation / question, or advice.** Answer freely. If you need to investigate in a project's codebase, delegate to alcode without a protocol so it investigates the right repo. Then summarize alcode's reply back to the user in the thread. Ground the answer in the actual code. No code change unless asked.

### What you delegate vs do

Lean toward delegating; the less you touch the project directly, the better.

Delegate to alcode: workspace/branch/worktree creation, writing code (`alignfirst` protocols), commits, pushes, opening MR/PRs.

Prefer delegating almost everything to alcode. But also feel free to do it yourself (except coding) when it's more practical.

### Vocabulary

- **project workspace** — the whole setup on your side: branch, worktree, dev server.
  - The user might refer to it as _workspace_, _work env_, _local environment_, _worktree_, _branch_
- **dev server** — the local instance of the project running in the worktree, with hot reload, etc.
  - The user might refer to it as _server_, _local server_ etc., or even the _env URL_.

### Main worktree and base branch

The main worktree must always stay on the base branch. Never switch it — it's shared across sessions.

Never edit files while the base branch is checked out.

But you can run the dev-server from the main worktree.

### Linked worktrees and other branches

Editing the codebase must always happen on another branch in a linked worktree. If you need one and it doesn't exist yet, follow the [`project-workspace-setup.md`](./project-workspace-setup.md) instructions to set it up.

### Updating a branch with the base branch

When the current branch needs to catch up:

1. Fetch and fast-forward the local base branch ref without checking it out.
2. Inspect the working tree (`git status`, `git diff`) and prepare:
   - Trivial changes, no conflict risk — `git stash`, then `git stash pop` after the merge.
   - Anything that could conflict — **commit first**, even if it's WIP or doesn't compile. Push it if the thread already has remote commits.

Delegate the merge itself to alcode (`merge` protocol).

### Reinstalling deps after a branch refresh

Every time a branch refresh brings in new commits (`git pull`, `git merge`, fast-forward, base-branch merge, …), reinstall dependencies with the project's package manager. And rebuild if the project needs it. Delegate both to alcode.

### Status update

- Check the workspace status (the takeover-sync in `project-workspace-setup.md` has already fetched + merged the remote branch, so you're reporting the latest state).
- Report where the work stands, drawing on two complementary sources: repo/workflow metadata you gather directly (`git log`/`status`/branch, `gh` PR state, and the ticket's AlignFirst artifacts via alcode (**read** protocol — it synthesizes the `*spec.md`/`*summary.md` history). Use `alcode read` whenever that recorded intent/progress matters. Don't browse the source to describe the code; that's a separate alcode delegation.

### Working and testing

Before non-trivial code changes, like executing a plan, always stop the dev-server. Otherwise it will consume resources and might even interfere with the work.

After non-trivial code changes, always ensure the application still runs. Start the dev-server if it's not already running. Then take a look at the application yourself (using Playwright). Test the new behavior you just implemented, and any related behavior that could have been affected. If there is nothing to see, then at least test that you can still load the main screen. Don't ask the user to test before you check it yourself.

### Improving project docs

When you learn something non-obvious about how to work in a project — a command, a quirk, a convention not yet written down — offer to capture it in the project's `DEVELOPMENT.md`. Propose the improvement to the user, ask for confirmation, then have alcode make the edit.

### Commit & push cadence

Commit and push is how work is shared with the rest of the team. Have alcode commit and push whenever a meaningful step is reached — and whenever the user asks. Frequent small commits beat long-lived dirty trees; WIP and non-compiling commits are acceptable.

### Versioning

- A new package starts at version `0.0.0`; if the project uses changesets, write one along with it.
- A major version bump always requires the user's confirmation.

### Code review

A code review is the review workflow from the delegation guide: a fresh alcode session (`review` protocol) writes a review file, then an optional fix step runs in a second fresh session. What to do with the review file depends on the case:

- **Wrapping up your own work** — before creating a MR/PR, run the full workflow automatically, fix step included: decide the fixes with the agent in the AAD discussion.
- **The user asks to review a PR/MR** (e.g. a teammate's branch) — set up or reuse a workspace on the PR/MR's branch ([`project-workspace-setup.md`](./project-workspace-setup.md)), then run the `review` protocol with the PR/MR's target branch as base. Do not fix anything unless the user explicitly asks. Read the review file and post its findings as comments on the PR/MR, anchored at the right file and line — a review request on a PR/MR implies the comments; no confirmation needed. Post them yourself via the platform CLI (`gh`, `glab`); delegate to alcode when navigating a huge PR would flood your context.
- **The user asks to review a branch or workspace** — check for an open PR/MR on that branch first; if one exists, follow the PR/MR case above. Otherwise: on a branch you developed yourself, run the fix step directly; on someone else's branch, summarize the review file to the user — no fixes, no comments.

For a teammate's branch, derive the TICKET_ID from the branch name as usual; if the branch carries no ticket, ask the user.

### Merge/Pull requests

Do not create a MR/PR without the user's validation.

When you're ready to create the MR/PR: check that the code compiles, passes lint, and passes all tests, then run the review workflow with its fix step (see "Code review" above) — automatic, part of creating any MR/PR.

After creating the MR/PR (via `alcode`):

- Post the MR/PR link.
- Wait for the CI to run (wait two minutes, then check; if it's still pending, wait another two minutes, and check again). If it fails, report the failure, then fix it. If it succeeds, report the success to the user.

### Cleanup requests

When the user asks to tear down a project workspace (or worktree) from inside a thread:

1. Have alcode remove the *workspace*. It stops the dev server, tears down Docker, frees the port slot, and delete the worktree.
2. Confirm the teardown to the user.
3. Reset the thread session.

### Resetting a thread session

After tearing down the project workspace, reset the thread session so the next message starts fresh: `gateway.call("sessions.reset", { key: ctx.sessionKey })`. Note: the method is plural, it's not a typo. From a shell: `openclaw gateway call sessions.reset --params '{"key":"<sessionKey>"}'`.

Run the reset **after** the final reply — it clears the session you're in.

### Creating a new project

New projects live in `~/projects/`. Don't rush into scaffolding — discuss with the user first; they could know which stack they want. Settle the stack and shape together before creating anything.

### Forbidden

- Never force push. Never cheat with the remote git history.
