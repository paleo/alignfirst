# Upgrade AlignFirst to v3

This prompt detects your current AlignFirst version (v1 or v2) and runs the appropriate migration.

> **Note**: Commands shown are Unix-style. Adapt to your OS if needed (e.g., PowerShell on Windows).

## Step 1 — Prerequisites

1. If this is a git repository, verify the working tree is clean. **Do not proceed with uncommitted changes.**

2. Verify you have access to the **docfront** skill. If you don't, stop and tell the user:

   > "I don't have access to the docfront skill. Please install it first:
   >
   > ```bash
   > npx skills add paleo/docfront --skill docfront
   > ```"

3. Verify the **docfront CLI** is available (e.g., check if `package.json` has a `docfront` script, or try running `npx docfront --help`). If not available, stop and tell the user:

   > "The docfront CLI is not installed in this project. Please install it first — ask your agent:
   >
   > ```text
   > Use your docfront skill. Install docfront CLI in this project.
   > ```"

## Step 2 — Detect Version

**Check for v1**: Look for `_docs/alignfirst/` or `_docs/vibe-flow/` directory.

**Check for v2**: Search for `alignfirst/SKILL.md` in any of these skills directories:

- `.claude/skills/`
- `.codex/skills/`
- `.github/skills/`
- `.cursor/skills/`
- `.gemini/skills/`
- `.agent/skills/`

**Important**: Ignore directories inside dependencies (`node_modules/`, `vendor/`, `venv/`, `.venv/`, `target/`, `build/`, `dist/`, etc.).

## Step 3 — Route

- **If v1 detected**: Fetch and follow **[upgrade-from-v1.md](https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/main/migrations/upgrade-from-v1.md)**.
- **If v2 detected**: Fetch and follow **[upgrade-from-v2.md](https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/main/migrations/upgrade-from-v2.md)**.
- **If neither**: Stop and tell the user:

  > "This project doesn't appear to have AlignFirst v1 or v2 installed. Use the installation instructions instead."
