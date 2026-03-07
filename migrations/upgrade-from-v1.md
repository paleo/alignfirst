# Upgrade from AlignFirst v1

This migration converts a v1 installation (`_docs/` system) to a v3-ready state.

> **Note**: Commands shown are Unix-style. Adapt to your OS if needed (e.g., PowerShell on Windows).

## Step 1 — Delete AlignFirst / Vibe Flow Files

```bash
rm -rf _docs/alignfirst _docs/vibe-flow
rm -f "_docs/Writing Documentation.md"
```

## Step 2 — Delete Command Files

Delete all known AlignFirst command files from **all** agent directories that exist in the project. Check every directory listed below and remove the matching files.

**Files to delete** (both old and new names):

- `spec.md`, `plan.md`, `dtdp.md`, `pr-message.md`, `doc.md`
- `al.md`, `alspec.md`, `alplan.md`, `aldescription.md`

**Directories to check:**

| Agent | Directory | Extension |
|-------|-----------|-----------|
| Claude Code | `.claude/commands/` | `.md` |
| Codex | `.codex/prompts/` | `.md` |
| GitHub Copilot | `.github/prompts/` | `.prompt.md` |
| Cursor | `.cursor/commands/` | `.md` |
| Antigravity | `.agent/workflows/` | `.md` |

_Note: For GitHub Copilot, the files have a `.prompt.md` extension (e.g., `al.prompt.md`)._

## Step 3 — Rename `_plans/` to `.plans/`

- If **only `_plans/`** exists: `mv _plans .plans`
- If **both `_plans/` and `.plans/`** exist: `mv _plans .plans/_plans-archives`
- If **only `.plans/`** exists: nothing to do.

Then, remove `.plans/.gitkeep` if it exists:

```bash
rm -f .plans/.gitkeep
```

## Step 4 — Update `.gitignore`

Remove all lines referencing `_plans` (e.g., `_plans/*`, `!_plans/.gitkeep`, `_plans`).

Ensure the following line is present:

```text
.plans
```

## Step 5 — Clean AGENTS.md

If `AGENTS.md` (or `CLAUDE.md`) exists, edit it:

1. Remove all references to `_docs/` files. This includes mentions of:
   - `AlignFirst Guide.md` or `Vibe Flow Guide.md`
   - `How to Write a Technical Specification.md`
   - `How to Write Implementation Plans.md`
   - `How to Write a Description.md`
   - `Discuss-Then-Do Protocol.md` or `Align-and-Do Protocol.md`
   - `Writing Documentation.md`
2. Replace any remaining `_plans` references with `.plans`.
3. Remove sections that become empty after these changes.

## Step 6 — Migrate Remaining Documentation (Conditional)

Check if any `.md` files remain in `_docs/`.

- **If files remain**: Use the **docfront** skill to migrate them. Specifically, use its "Migrate Existing Documents" capability to bring the `_docs/` contents into a new `docs/` directory (do not modify in-place). After a successful migration, delete the old directory:

  ```bash
  rm -rf _docs
  ```

- **If no files remain**: Delete the empty directory:

  ```bash
  rm -rf _docs
  ```

## Done

Summarize what was done:

- AlignFirst/Vibe Flow v1 files removed
- Command files removed (list which agent directories were cleaned)
- `_plans` renamed to `.plans`
- `.gitignore` updated
- `AGENTS.md` cleaned
- Whether documentation was migrated to `docs/` via docfront, or no remaining docs were found
