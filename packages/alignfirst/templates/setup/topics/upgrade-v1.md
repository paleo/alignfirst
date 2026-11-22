# Upgrade from `_docs/` Instructions

Remove the legacy `_docs/` system while preserving project knowledge. Continue with `{{CMD}} setup guide upgrade-v3` after these steps.

Commands are Unix-style. Adapt them for another shell, such as PowerShell on Windows.

## Step 1 — Delete AlignFirst, Vibe Flow and AI Workflow Files

```bash
rm -rf _docs/alignfirst _docs/vibe-flow _docs/ai-workflow
rm -f "_docs/Writing Documentation.md"
```

If `_docs/INDEX.md` exists, read it. When it contains project-specific information beyond the generic AI Workflow index and boilerplate, preserve that information in `AGENTS.md` or `CLAUDE.md`. Then delete the file:

```bash
rm -f _docs/INDEX.md
```

## Step 2 — Delete Command Files

Delete all known AlignFirst command files from **all** agent directories that exist in the project. Check every directory listed below and remove the matching files.

Files to delete, under both old and new names:

- `spec.md`, `plan.md`, `dtdp.md`, `pr-message.md`, `doc.md`
- `al.md`, `alspec.md`, `alplan.md`, `aldescription.md`, `almerge.md`, `alreview.md`, `alread.md`

Directories to check:

| Agent | Directory | Extension |
| --- | --- | --- |
| Claude Code | `.claude/commands/` | `.md` |
| Codex | `.codex/prompts/` | `.md` |
| GitHub Copilot | `.github/prompts/` | `.prompt.md` |
| Cursor | `.cursor/commands/` | `.md` |
| Antigravity | `.agent/workflows/` | `.md` |

For GitHub Copilot, the files have a `.prompt.md` extension, such as `al.prompt.md`.

## Step 3 — Rename `_plans/` to `.plans/`

- If **only `_plans/`** exists: `mv _plans .plans`
- If **both `_plans/` and `.plans/`** exist: `mv _plans .plans/_plans-archives`
- If **only `.plans/`** exists: nothing to do.

Then remove `.plans/.gitkeep` if it exists:

```bash
rm -f .plans/.gitkeep
```

Search the entire codebase for references to `_plans` (source code, configuration files, documentation) and replace them with `.plans`.

## Step 4 — Update `.gitignore`

Remove all lines referencing `_plans`, such as `_plans/*`, `!_plans/.gitkeep` and `_plans`.

Ensure `.gitignore` contains `.plans`, replacing the old block (`.plans/**`, `!.plans/**/`, `!.plans/**/*.shared.md`) if found. If any `*.shared.md` files are committed, untrack them with `git rm --cached` and tell the user about them.

## Step 5 — Clean `AGENTS.md`

If `AGENTS.md` or `CLAUDE.md` exists, edit it:

1. Remove all references to `_docs/` files. This includes mentions of:
   - `AlignFirst Guide.md`, `Vibe Flow Guide.md` or `AI Workflow Guide.md`
   - `How to Write a Technical Specification.md`
   - `How to Write Implementation Plans.md`
   - `How to Write a Description.md`
   - `Discuss-Then-Do Protocol.md` or `Align-and-Do Protocol.md`
   - `Writing Documentation.md`
2. Replace any remaining `_plans` references with `.plans`.
3. Remove sections that become empty after these changes.

## Step 6 — Migrate Remaining Documentation (Conditional)

Check whether any `.md` files remain in `_docs/`.

- **If files remain:** follow `{{CMD}} setup guide docmap-migrate-docs` to bring the `_docs/` contents into a new `docs/` directory; do not modify them in place. After a successful migration, delete the old directory:

  ```bash
  rm -rf _docs
  ```

- **If no files remain:** delete the empty directory:

  ```bash
  rm -rf _docs
  ```

## Finish the Upgrade

Continue with `{{CMD}} setup guide upgrade-v3` for the project configuration, the stub skills and the current commands.

Summarize:

- Legacy AlignFirst, Vibe Flow and AI Workflow files removed
- Command files removed, with the agent directories cleaned
- `_plans` renamed to `.plans`
- `.gitignore` updated
- `AGENTS.md` cleaned
- Whether documentation was migrated to `docs/` through Docmap, or no remaining docs were found
- The scope and agents that received the CLI-backed AlignFirst skills
