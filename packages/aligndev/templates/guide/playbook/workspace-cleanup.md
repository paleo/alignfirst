# Runbook: Workspace cleanup

Read this runbook for a teardown or cleanup request, and whenever you observe a merged PR/MR.

## Cleanup requests

{{#thread}}
When the user asks to tear down one named project workspace (or worktree) from inside a thread:
{{/thread}}
{{#conversation}}
When the user asks to tear down one named project workspace (or worktree):
{{/conversation}}

1. Resolve the exact linked-worktree path through `{{ALIGNFIRST}} workspace list --json`; ask the user when it is ambiguous. Run `{{ALIGNFIRST}} workspace remove <exact-path>` from PROJECT_PATH yourself. It stops services, purges resources and protects dirty, locked, main, nested and shared-target paths; never force it. When an external tool owns deletion, run `{{ALIGNFIRST}} workspace teardown <exact-path>` instead, then let that owner delete it. Neither operation needs a coding launch or work-files preparation, even when plans are unsuitable. Stop on failure and retain state for retry.
2. Confirm what was removed.
{{#thread}}
3. Reset the thread session.
{{/thread}}
{{#app}}
3. Say, in the same message, that this conversation can be archived.
{{/app}}

{{#openclaw}}
When the user asks to clean the workspaces, for each affected PROJECT_PATH:
{{/openclaw}}
{{#codingAgent}}
When the user asks to clean the workspaces, from PROJECT_PATH:
{{/codingAgent}}

1. List the worktrees through `{{ALIGNFIRST}} workspace list --json`.
2. For each linked workspace, find its branch's PR/MR through the configured code-hosting tool. Remove the workspace as in "Cleanup requests", only when that PR/MR is merged. Leave the others intact: in-place work, no PR/MR, or an unmerged PR/MR. Stop on the first failed removal.
3. When a workspace was removed, delegate the merge target's refresh as "After a merge" below describes. Any needed installation uses the committed lockfile without rewriting it (`npm ci` with npm).
4. Report every decision, any blocked refresh, and the final base-branch state.

## After a merge

Whenever you observe that a PR/MR is merged:

1. Remove the source branch's linked workspace as "Cleanup requests" above describes. A branch worked on in place stays checked out: the user decides when to leave it.
2. Delegate the refresh of the merge target without a protocol: in the main worktree, clean and on its base branch, fetch and fast-forward it, then apply "Refreshing the workspace after a branch refresh" from your working-session guide.
3. Report the removed workspace and refreshed branch. When unsuitable plans block the refresh delegation, the removal still happens; report the blocked refresh.
{{#app}}

For this conversation's externally owned worktree, run `{{ALIGNFIRST}} workspace teardown` and report that it is ready for its owner to archive and delete. Adoption does not transfer deletion ownership.
{{/app}}

{{#thread}}
## Resetting a thread session

After tearing down the project workspace, reset the thread session so the next message starts fresh: `gateway.call("sessions.reset", { key: ctx.sessionKey })`. Note: the method is plural, it's not a typo. From a shell: `openclaw gateway call sessions.reset --params '{"key":"<sessionKey>"}'`.

Run the reset **after** the final reply — it clears the session you're in.
{{/thread}}
