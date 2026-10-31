# Work-Files Repository Setup

Share `.plans/` through a separate team repository, or keep it as an ignored local directory. Protocols and Docmap work independently of workspace adoption.

## Project settings

In `alignfirst.json` (strict JSON) or `alignfirst.jsonc` (comments/trailing commas):

```json
{
  "schemaVersion": 1,
  "plans": { "repositoryFolder": "project-a", "autoArchive": true }
}
```

The team repository contains one folder per project, with ticket directories and `_archives/`. `repositoryFolder` selects that folder. The deprecated `plans.folder` spelling is rejected. Existing `.alignfirst.json` users follow [the clean-break runbook](upgrading-multi-stack-workspaces.md).

## Each machine

Clone with the developer's credentials, then link from the project:

```sh
git clone <plans-repository-url> <plans-clone-path>
npx -y alignfirst plans setup <plans-clone-path>
npx -y alignfirst plans check
npx -y alignfirst sync
```

Without `repositoryFolder`, supply `--folder project-a` once. `plans setup` creates the configured folder and may migrate existing local plans into the separate repository; obtain authorization before moving existing history. It creates a relative symlink at the effective plans location, including a selected companion. Re-run after moving the clone.

For local mode, create `.plans/` and ignore it. A public project's README should offer local mode without exposing a private work-files URL. The product repository must not track effective plans; a separate work-files repository may track them.

`plans.autoArchive: true` makes sync archive stale tickets and completed no-ticket sessions under `_archives/`; remove it to opt out. `ALIGNFIRST_ARCHIVE_DAYS` defaults to 7. Running `_aligndev/*.running.md` logs are excluded from snapshots. Shared sync serializes through a clone lock, consolidates pending sync commits and retries busy/advancing remotes up to three times. A conflict aborts rebase and retains local commits; resolve it in the clone with `git pull --rebase`, then retry sync.

With the canonical `alignfirst context` bootstrap, the CLI supplies the sync instruction; do not duplicate it in the developer guide. Otherwise document: after every `.plans/` change, run `npx -y alignfirst sync`. Include work-files provisioning in the README's local installation procedure only when it requires a manual step.

## Before workspace setup

Prepare effective plans and selected runtime storage (ignore `.local-wt/` only for project-local runtime) before `npx -y alignfirst workspace setup`. No pre-setup wrapper check is needed: the CLI validates main before creating a branch/worktree, then validates linked-worktree parity. Main's project-local plans are shared through a link; companion plans resolve directly without one. Setup never provisions missing plans, selects companions or edits tracked ignore rules.

For an assistant, use the separately authorized `aligndev guide work-files-setup` procedure before ticket reservation, request capture or coding effects. Preserve existing tracked/missing-history boundaries and companion selections. See [workspace setup](workspace-setup.md#required-baseline-and-defaults).
