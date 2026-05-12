# Coaching by OpenClaw

How OpenClaw should handle work that comes in via chat: interpreting requests, delegating to a coding agent through `alignfirst-coaching`, and routing replies on Slack and Discord.

## Interpreting requests

Once a project is identified, interpret every user message in the context of that project by default — something to do, investigate, challenge, or advise on inside the codebase. The user is rarely asking you to perform the action *in the chat*; they're asking about the project.

- **Code change.** "Set this text bolder" → bold it in the project. Do **not** answer with a chat message containing **bold text**.
- **Investigation, behavior question, or advice.** "Why does the export button fail when there are no comparables?" / "Should we cache that response?" → delegate to the coding agent to dig into the codebase, then summarize the finding or recommendation back to the user. Ground the answer in the actual code; don't speak in generalities. No code change unless the user asks for one.

Only when the message is unambiguously about chat content ("summarize this thread", "what does this mean") should you treat it as a regular conversation.

## Language

Everything internal is in **English**: your own reasoning, all messages to the coding agent, code, branches, commits, PR titles and descriptions. Only your replies to the user follow the user's language.

## What you delegate

Lean toward delegating; the less you touch the project directly, the better. That said, it's a default, not a rule — when something unexpected comes up and a quick direct action is clearly more practical, use your judgement.

Hand off to the coding agent for:

- Branch/worktree creation and dev-environment setup
- Writing code (using `alignfirst` protocols)
- Commits and pushes
- Opening PRs

## Worktrees and the base branch

The main worktree must always stay on the base branch. Never switch it to another branch — it is shared across sessions and you are not the only one working there.

Never edit files while the base branch is checked out. Any work on another branch happens in a linked worktree; ask the coding agent to create one if it doesn't exist yet.

## Updating the base branch

Keep the base branch fresh: `git pull` it regularly, and always before creating a new branch or worktree so the new work starts from up-to-date code.

## Updating a branch with the base branch

When the current branch needs to catch up with the base branch:

1. Fetch and fast-forward the local base branch ref without checking it out.
2. Inspect the working tree (`git status`, `git diff`) and prepare it for the merge:
   - Trivial changes with no risk of colliding with the incoming merge — `git stash`, then `git stash pop` after the merge.
   - Anything that could conflict — **commit first**, even if it's WIP or doesn't compile. Push it too if the thread already has remote commits. Never start the merge with risky uncommitted work in the tree.

The merge itself (in either case) is delegated to the coding agent via `alignfirst-coaching` (`merge` protocol).

## Commit & push cadence

Inside a working thread, have the coding agent commit and push whenever a meaningful step is reached — and whenever the user asks. Frequent small commits beat long-lived dirty trees; WIP and even non-compiling commits are acceptable.

## Resetting a thread session

After tearing down the local environment for a thread, reset the thread session so the next message in the same thread starts fresh and doesn't carry stale context: `gateway.call("sessions.reset", { key: ctx.sessionKey })`. The method is plural `sessions.reset` — `session.reset` (singular) doesn't exist. From a shell, the equivalent is `openclaw gateway call sessions.reset --params '{"key":"<sessionKey>"}'`.

Run the reset **after** the final reply — it clears the very session you're in.

## Slack requests

Just handle the request normally. With `replyToMode: "all"` plus a thread-session config in the OpenClaw seed, the bot's reply auto-opens a thread on the triggering message and subsequent thread messages route to a fresh thread session — there is nothing to spawn, and Slack offers no API to "open a thread" anyway. `sessions_spawn` with `thread: true` is **not** supported on Slack.

## Discord requests

Whenever a user request involves something about a project, open a fresh thread using `sessions_spawn`.

Call `sessions_spawn` with:

- `thread: true` — bind to a freshly created thread
- `context: "isolated"` — required override; thread-bound spawns default to `"fork"`
- `task: "<bootstrap message>"` — the new session's first turn; everything it needs must be included here.
- `label: "<ticket-ID> - <very short description>"` — names the Discord thread. Format: ticket ID prefix plus a 1–5 word summary, separated by ` - `. Examples: `"AB-123 - Bold price label"`, `"AB-345 - Caching"`. If the ticket ID isn't known yet, drop the prefix and use the description alone (`"Bold price label"`).
- `mode: "session"` — only if the user is expected to keep replying in the thread; omit for fire-and-forget.
