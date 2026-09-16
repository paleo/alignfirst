# Consultation

Read-only work: a question about the codebase, advice, a design opinion, a brainstorming. It produces understanding and decisions, never code. The protocols investigate too, but on the way to building something; a consultation stops at the answer.

A code review or an explicitly named AlignFirst protocol is not a consultation: those follow the ticket and workspace flow. Everything else here needs PROJECT and PROJECT_PATH, and nothing more — no ticket to start, no request file, no project workspace.

The user consults you, and you consult alcode. It reads the repository; you would answer from memory. So every question, every request for ideas, and every opinion you need for your own next step goes to alcode, and you relay its answer in your own words.

## Step 1 — Select the worktree

Read `{PROJECT_PATH}/DEVELOPERS.md` and run `alignfirst context` from PROJECT_PATH.

Use the main worktree on the configured default branch. When the question explicitly concerns a branch or a PR, or follows ongoing branch work in this thread, use that branch's existing registered workspace instead: resolve it through the project's workspace guide, and report the limitation rather than inspecting a different branch when no workspace exists.

## Step 2 — Refresh the default branch

Skip this step when Step 1 selected an existing branch workspace; inspect its current state as it is, without the workspace setup or branch-sync procedure.

Before delegating against the default branch, verify that the main worktree is clean and on that branch. Fetch its remote and fast-forward from its upstream with `git merge --ff-only`.

Stop and report the obstacle when the branch is wrong, the worktree is dirty, the upstream is missing, or the refresh fails. Preserve local work: a question is never a reason to switch branches, stash, commit, reset, or resolve a merge.

Retain `git rev-parse --short HEAD` after the refresh. Other sessions fast-forward the same worktree, so this records which revision the answer came from. Report it when something in the answer looks inconsistent, and in the Step 5 record.

## Step 3 — Delegate

Apply the takeover-turn checkpoint in `SKILL.md`, then run `alcode new --message` from the selected worktree, without `--protocol`, `--ticket`, or `--no-ticket`.

The message carries the complete question, however detailed, the selected branch, and an explicit constraint to investigate and answer without implementing changes. Include the environment refresh described in the working session when the main branch advanced. Use the delegation guide's background launch and completion procedure.

Retain the printed session id. Later turns of the same topic resume that session, so the discussion accumulates in one place.

## Step 4 — Relay

Answer in the thread, in your own words, grounded in what alcode found.

A request for changes ends the consultation: return to the ticket and linked-workspace flow before anything is implemented.

## Step 5 — Record a discussion

A single question answered in one turn ends at Step 4. Nothing is written.

Record the exchange when it produced something worth keeping: the user asked for ideas, an opinion, or a decision, or the topic continued past your first answer. Then:

1. **Ask about the ticket, without waiting for it.** Add one sentence to the answer you are already sending, in the user's language: *"Is there a ticket to attach this discussion to, or do we continue without one?"* Ask it once in the session, then carry on regardless of the reply.
2. **Establish TICKET_ID** on the turn that states a decision, or when the user asks to wrap up or changes topic. Use the ticket the user named, or run `alignfirst ticket --side` from PROJECT_PATH and take the `side-N` it reports.
3. **Name the file.** Run `alignfirst sync`, then `alignfirst ticket {TICKET_ID} --next consultation.md --new-cycle`, both from PROJECT_PATH, and append FILE_NAME to TICKET_DIR, preserving the leading dot. Syncing first brings down the ticket's existing work files, so the new file is numbered after them. A consultation opens its own cycle, and the flag is harmless on a ticket with no work files yet.
4. **Have alcode write it.** Resume the consultation's session with no protocol, naming that exact path. Ask for the discussion's summary, the ideas considered, the decisions reached, and the open questions named as open. alcode syncs its own writes.
5. **Report where it landed.** Your closing message states TICKET_ID and the file path. The file names the revision retained at Step 2.

Writing under `.plans/` from the main worktree is allowed on the base branch; the prohibition covers the codebase. This step creates no branch and no project workspace.
