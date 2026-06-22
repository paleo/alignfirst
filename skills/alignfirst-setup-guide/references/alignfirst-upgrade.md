# Upgrade AlignFirst to v3

This prompt detects your current AlignFirst version (v1 or v2) and runs the appropriate migration.

> **Note**: Commands shown are Unix-style. Adapt to your OS if needed (e.g., PowerShell on Windows).

## Step 1 — Prerequisites

1. If this is a git repository, verify the working tree is clean. **Do not proceed with uncommitted changes.**

2. Verify the **docmap CLI** is available (e.g., check if `package.json` has a `docmap` script, or try running `npx docmap --help`). If not, install it first by following [docmap-setup.md](docmap-setup.md).

## Step 2 — Ensure Conventions Section

Check if `AGENTS.md` or `CLAUDE.md` exists. If one exists, use it as the INSTRUCTION_FILE. If neither exists, create `AGENTS.md`.

Check if the INSTRUCTION_FILE already contains an `## AlignFirst` section with ticket ID and commit message conventions. If it does and it looks correct, skip ahead. Otherwise:

1. Look at git branches (`git branch -a`) to detect a ticket ID format (e.g., `ABC-###`, `PROJ-###`, or numeric).
2. If no pattern is found, ask the user:

   > "I couldn't detect a ticket ID format from the branch names. Please provide the ticket ID format (e.g., "numeric", `ABC-###`, etc.)"

3. From recent commit messages (`git log --oneline -20`), deduce the commit message convention (e.g., `<type>: [<ticket-id>] description`, `<type>(<scope>): description`, `[<ticket-id>] description`, etc.).
4. If no pattern is found, ask the user:

   > "I couldn't detect a commit message convention. Please describe it (e.g., `feat: [#123] short description`, `type(scope): description`, etc.) or type 'skip' to omit."

5. Detect the default branch with `git remote show origin | grep "HEAD branch"` (e.g., `main`, `master`, `develop`).

6. Add (or fix) this section in the INSTRUCTION_FILE (include each convention line only if one was detected or provided):

   > ## AlignFirst - Ticket ID, Commit Message, Default Branch
   >
   > _Ticket ID_: Format is `{DETECTED_FORMAT}`. Use the ticket ID if explicitly provided. Otherwise, deduce it from the current branch name (no confirmation needed). If the branch name is unavailable, get it via `git branch --show-current`. Only ask the user as a last resort.
   >
   > _Commit message convention_: `{DETECTED_CONVENTION}`
   >
   > _Default branch_: `{DETECTED_DEFAULT_BRANCH}`

## Step 3 — Detect Version

**Check for v1**: Look for `_docs/alignfirst/`, `_docs/vibe-flow/`, or `_docs/ai-workflow/` directory.

**Check for v2**: Search for `alignfirst/SKILL.md` in any of these skills directories:

- `.claude/skills/`
- `.codex/skills/`
- `.github/skills/`
- `.cursor/skills/`
- `.gemini/skills/`
- `.agent/skills/`

**Important**: Ignore directories inside dependencies (`node_modules/`, `vendor/`, `venv/`, `.venv/`, `target/`, `build/`, `dist/`, etc.).

## Step 4 — Route

- **If v1 detected**: Follow [alignfirst-upgrade-from-v1.md](alignfirst-upgrade-from-v1.md).
- **If v2 detected**: Follow [alignfirst-upgrade-from-v2.md](alignfirst-upgrade-from-v2.md).
- **If neither**: Stop and tell the user:

  > "This project doesn't appear to have AlignFirst v1 or v2 installed. Use the installation instructions instead."
