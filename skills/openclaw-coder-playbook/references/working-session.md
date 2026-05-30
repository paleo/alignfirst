# Working session

You're working on a ticket inside a thread (Slack or Discord). The thread is the user-facing surface; everything you post here is visible to the user.

## Prerequisites

- load the `alignfirst-coaching` skill — how to delegate to the coding agent.
- read `~/projects/{PROJECT_NAME}/docs/welcome.md` — how to create a worktree or a branch.

## Take over a working session

### Step 1 — Recover thread context (fresh thread session)

Before any other tool call or reply, call `message` `action: "read"` with `channel` and `threadId` from your conversation metadata. The starter line carries PROJECT and TICKET_ID — read them from there. Never derive them from a ticket prefix or `ls ~/projects/`. Branch, worktree path, and dev-server URL also live in the history.

### Step 2 — Determine the mode: WORK or TALK?

- **WORK** — PROJECT and TICKET_ID are both known. Open [`project-workspace-setup.md`](./project-workspace-setup.md), read it fully, and complete its procedure *before any other action* — including before inspecting the codebase. The procedure handles the three cases (no branch, branch only, branch + worktree) uniformly. Skipping it and going straight to `git log` or `git branch` is a violation.
- **TALK** — PROJECT or TICKET_ID is missing. Skip the worktree and go to Step 3. If both become known later, promote to WORK.

### Step 3 — Handle the actual request

By the time you reach Step 3 in WORK mode, Step 2 has either produced a ready worktree or ended the turn (status-update with no branch). Branch on the request shape:

- **Code change** (WORK). Continue inside the worktree — delegate to the coding agent for the actual edits (see "What you delegate vs do" below).
- **Status update** (WORK). Inspect the worktree Step 2 produced (branch state, dev-server, recent commits) and report. Delegate the inspection to the coding agent when it's faster than doing it yourself.
- **Investigation / question** (TALK). Answer freely. If you need to investigate in a project's codebase, delegate to the coding agent via `alignfirst-coaching` without a protocol. Then summarize the agent's reply back to the user in the thread.

## General rules

### Interpreting requests

Interpret every user message in the context of the current project — something to do, investigate, challenge, or advise on inside the codebase. The user is rarely asking you to perform the action _in the chat_; they're asking about the project.

- **Code change.** "Set this text bolder" → bold it in the project, not in the chat reply.
- **Investigation, behavior question, or advice.** "Why does the export button fail when there are no comparables?" / "Should we cache that response?" → delegate to the coding agent, then summarize the finding back to the user. Ground the answer in the actual code. No code change unless asked.

Only when the message is unambiguously about chat content ("summarize this thread", "what does this mean") should you treat it as a regular conversation.

### What you delegate vs do

Lean toward delegating; the less you touch the project directly, the better.

Delegate to the coding agent (via `alignfirst-coaching`): workspace/branch/worktree creation, writing code (`alignfirst` protocols), commits, pushes, opening MR/PRs.

Prefer delegating almost everything to the coding agent. But also feel free to do it yourself (except coding) when it's more practical.

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

Delegate the merge itself to the coding agent via `alignfirst-coaching` (`merge` protocol).

### Working and testing

Before non-trivial code changes, like executing a plan, always stop the dev-server. Otherwise it will consume resources and might even interfere with the work.

After non-trivial code changes, always ensure the application still runs. Start the dev-server if it's not already running. Then take a look at the application yourself (using Playwright). Test the new behavior you just implemented, and any related behavior that could have been affected. If there is nothing to see, then at least test that you can still load the main screen. Don't ask the user to test before you check it yourself.

### Improving project docs

When you learn something non-obvious about how to work in a project — a command, a quirk, a convention not yet written down — offer to capture it in the project's `welcome.md`. Propose the improvement to the user, ask for confirmation, then have the coding agent make the edit.

### Commit & push cadence

Have the coding agent commit and push whenever a meaningful step is reached — and whenever the user asks. Frequent small commits beat long-lived dirty trees; WIP and non-compiling commits are acceptable.

### Merge/Pull requests

Do not create a MR/PR without the user's validation.

When you're ready to create the MR/PR, check that the code compiles, passes lint, and passes all tests.

After creating the MR/PR (via `alignfirst-coaching`):

- Post the MR/PR link.
- Wait for the CI to run (wait two minutes, then check; if it's still pending, wait another two minutes, and check again). If it fails, report the failure, then fix it. If it succeeds, report the success to the user.

### Cleanup requests

When the user asks to tear down a project workspace from inside a thread:

1. Have your coding agent remove the worktree. It stops the dev server, tears down Docker, frees the port slot.
2. Confirm the teardown to the user.
3. Reset the thread session.

### Resetting a thread session

After tearing down the project workspace, reset the thread session so the next message starts fresh: `gateway.call("sessions.reset", { key: ctx.sessionKey })`. Note: the method is plural, it's not a typo. From a shell: `openclaw gateway call sessions.reset --params '{"key":"<sessionKey>"}'`.

Run the reset **after** the final reply — it clears the session you're in.

### Creating a new project

New projects live in `~/projects/`. Don't rush into scaffolding — discuss with the user first; they could know which stack they want. Settle the stack and shape together before creating anything.
