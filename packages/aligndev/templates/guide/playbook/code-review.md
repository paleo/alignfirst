# Runbook: Code review

_Note: Before every code review, always start by updating both the base branch and the branch to review._

A code review is the review workflow below: a fresh agent session (`review` protocol) writes a review file, then an optional fix step runs in a second fresh session, never in the review session. What to do with the review file depends on the case:

- **Wrapping up your own work** — `{{GUIDE}} change-wrap-up` decides whether the review runs. When it does, run the review and fix steps automatically: decide the fixes with the agent in the AAD discussion, then recheck when the workflow calls for it. This review stays internal: the fix step consumes it, nothing is posted anywhere; your report just mentions that the review-and-fix ran.
- **The user asks to review a PR/MR** (e.g. a teammate's branch) — follow the PR/MR review sequence below.
- **The user asks to review a branch or workspace** — check for an open PR/MR on that branch first; if one exists, follow the PR/MR review sequence. Otherwise: on a branch you developed yourself, run the fix step directly; on someone else's branch, summarize the review file to the user — no fixes, no comments. Take the TICKET_ID from the branch name; ask the user when it carries none.

The PR/MR review sequence:

1. Read the PR/MR via the platform CLI (`gh`, `glab`). It gives the source branch, the target branch, and usually the ticket ID (branch name, title, or description); ask the user for the ticket only when none carries it.
2. Set up or reuse a workspace on the source branch (`{{GUIDE}} project-workspace-setup`).
3. Run the `review` protocol with the target branch as base. Do not fix anything unless the user explicitly asks.
4. Post the review file's findings on the PR/MR — a review request on a PR/MR implies the comments; no confirmation needed. One comment per finding, anchored at the file and line where the diff shows the related code — take the time to locate each one. One general comment for findings with no precise spot. Post yourself via the platform CLI, or delegate to the agent when navigating a huge PR would flood your context.
5. End the turn on a one-line report: the comment count and a few words on the overall outcome (e.g. "Posted 6 comments on the MR — solid branch, two real bugs.").

The fix step is also how you process a review that arrives from outside — a teammate's review comments on your PR/MR, a review file the user points at. As the workflow describes, point the fix session at wherever the review lives (the file, or the PR/MR reference so the agent fetches the comments itself); discuss the reworks with the agent, then it implements.

## Following up on a review

The author of a branch you reviewed pushes fixes and asks you to check them, or you notice new commits on that branch after your comments. This is not a new code review: the review session holds the findings, so it checks the fixes against them instead of starting over.

1. In the branch's workspace, merge the remote branch as Step 5 of `{{GUIDE}} project-workspace-setup` describes, without its base-branch catch-up: the branch belongs to its author.
2. Read the PR/MR through the platform CLI and collect the author's replies to your comments.
3. Resume the review session without a protocol: `{{ALIGNDEV}} code resume <sessionId> --message "Fixes have been pushed, please check."`, with the author's replies appended when there are any. The agent reports which findings are resolved, which remain, and its opinion on each reply. The review file stays as written.
{{#thread}}
4. Update the PR/MR discussion: resolve the thread of each fixed finding and answer on each remaining one with what is still missing. Without a PR/MR, report the outcome in the thread instead.
{{/thread}}
{{#conversation}}
4. Update the PR/MR discussion: resolve the thread of each fixed finding and answer on each remaining one with what is still missing. Without a PR/MR, report the outcome in the conversation instead.
{{/conversation}}
5. End the turn on a one-line report: what is resolved and what remains.

## Review workflow

Two fresh sessions: one reviews, one fixes. Launch each run as `{{GUIDE}} code` describes.

1. **Review** — `{{ALIGNDEV}} code new --protocol review --ticket AB-123`. The agent reviews the current branch against the base branch and writes a review file; its path is in the run's result. Retain the session id.
   - **Options** — the message carries them, as in `--message "Light review. Starting commit: \`<sha>\`."`:
     - `Base branch: \`develop\`.` — the default is the repository's default branch.
     - `Starting commit: \`<sha>\`.` — the review covers the commits added after it. A review file names the commit it reviewed on its `Reviewed commit` line: pass that commit to have the later ones reviewed.
     - `Light review.` or `Regular review.` — the form. A light review is a single pass by the review session; a regular one runs four reviewers. Without a form, the agent takes the light review for a minor change and the regular one otherwise.
2. **Fix** (optional, always in a fresh session — never in the review session) — `{{ALIGNDEV}} code new --protocol aad --ticket AB-123 --message "Here is a code review: \`.plans/AB-123/B1-review.md\`. What should we fix?"`. Send this message as it is, pointed at wherever the review lives: the review file, or the PR/MR whose comments carry it. The agent challenges the findings and proposes fixes; decide together what to fix, as in any AAD session. The goal is the project's code quality, and a finding is not an order: welcome a fix or an expansion that cleans things up, refuse one that adds complexity; simplicity wins. The agent then implements and writes a summary file.
3. **Recheck** (when the fix session fixed an Important finding or went beyond the findings) — once the fixes are committed, resume the original review session without a protocol. Point at the fix summary and list unchanged findings with a few words of rationale each. Ask the reviewer to check the fixes, look for regressions they introduced, and assess those decisions. Ask it to then set the `Reviewed commit` line of its review file to the commit it checked. You decide what to do with its feedback.

Skip the fix step when the review is informational or has no finding. A review with nits alone still gets it: many nits improve the code.
