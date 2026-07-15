# Upgrade from AlignFirst v2

This migration converts a v2 installation (agent skills system) to a v3-ready state.

> **Note**: Commands shown are Unix-style. Adapt to your OS if needed (e.g., PowerShell on Windows).

## Step 1 — Detect Skills Directory

Find the skills directory that contains `alignfirst/SKILL.md`. Set **SKILLS_DIR** to this directory (e.g., `.claude/skills/`).

## Step 2 — Delete Known Skills

```bash
rm -rf {SKILLS_DIR}/alignfirst
rm -rf {SKILLS_DIR}/technical-documentation-authoring
```

## Step 3 — Delete Command Files

Delete all known AlignFirst command files from **all** agent directories that exist in the project. Check every directory listed below and remove the matching files.

**Files to delete**:

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

## Step 4 — Rename `_plans/` to `.plans/`

- If **only `_plans/`** exists: `mv _plans .plans`
- If **both `_plans/` and `.plans/`** exist: `mv _plans .plans/_plans-archives`
- If **only `.plans/`** exists: nothing to do.

Then, remove `.plans/.gitkeep` if it exists:

```bash
rm -f .plans/.gitkeep
```

Search the entire codebase for any references to `_plans` (in source code, configuration files, documentation, etc.) and replace them with `.plans`.

## Step 5 — Update `.gitignore`

Remove all lines referencing `_plans` (e.g., `_plans/*`, `!_plans/.gitkeep`, `_plans`).

Ensure this block is present, replacing any bare `.plans` line:

```text
.plans/**
!.plans/**/
!.plans/**/*.shared.md
```

These rules ignore the `.plans` directory but keep `*.shared.md` files tracked, so shared plans get committed. Insert the three lines as a block — the two `!` lines depend on the first. A leftover bare `.plans` line shadows the un-ignore rules.

## Step 6 — Clean AGENTS.md

If `AGENTS.md` (or `CLAUDE.md`) exists, edit it:

1. Remove references to the deleted skills (`alignfirst`, `technical-documentation-authoring`).
2. Replace any remaining `_plans` references with `.plans`.
3. Remove sections that become empty after these changes.

## Step 7 — Migrate Remaining Custom Skills (Conditional)

Check if any skill directories remain in `{SKILLS_DIR}/` (after deleting alignfirst and technical-documentation-authoring).

- **If skills remain**: Migrate them by following [docmap-migrate-skills.md](docmap-migrate-skills.md). This includes a discussion phase where the agent and user decide which skills to migrate and how to organize them.

- **If no skills remain**: Skip this step.

## Done

Summarize what was done:

- AlignFirst and technical-documentation-authoring skills removed
- Command files removed (list which agent directories were cleaned)
- `_plans` renamed to `.plans`
- `.gitignore` updated
- `AGENTS.md` cleaned
- Whether custom skills were migrated to `docs/` via docmap, or no remaining skills were found
