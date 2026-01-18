# Install AlignFirst Skill

This prompt installs the AlignFirst skill in a new project.

> **Note**: Commands shown are Unix-style. Adapt to your OS if needed (e.g., PowerShell on Windows).

## Step 1 - Check for Legacy Installation

Search for a `_docs/vibe-flow/` directory in the codebase.

- If it exists, **STOP NOW** and tell the user:

  > "You have a legacy Vibe Flow installation (`_docs/vibe-flow/`). Please use the migration prompt instead:
  >
  > <https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/main/migrations/upgrade-to-agent-skills.md>"

- If it does not exist, continue to Step 2.

## Step 2 - Check for Existing Installation

Search for an existing `alignfirst` or `vibe-flow` skill directory. Look for any directory containing `alignfirst/SKILL.md` or `vibe-flow/SKILL.md`.

**Important**: Ignore directories inside dependencies (`node_modules/`, `vendor/`, `venv/`, `.venv/`, `target/`, `build/`, `dist/`, etc.).

- If found, **STOP NOW** and tell the user:

  > "AlignFirst (or Vibe Flow) is already installed at `{PATH}`. To update it, use the update prompt instead:
  >
  > <https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/main/migrations/update-skills.md>"

- If not found, continue to Step 3.

## Step 3 - Detect Skills Directory

Search for existing `skills/` directories in the repository root:

- `.claude/skills/`
- `.codex/skills/`
- `.github/skills/`
- `.cursor/skills/`
- `.gemini/skills/`
- `.agent/skills/`

**Decision:**

- **If none exists**: Determine the installation directory based on the current agent:
  - Claude Code → `.claude/skills/`
  - Codex → `.codex/skills/`
  - GitHub Copilot → `.github/skills/`
  - Cursor → `.cursor/skills/`
  - Gemini CLI → `.gemini/skills/`
  - Antigravity → `.agent/skills/`
  - Other/unknown → `.claude/skills/`

- **If exactly one exists**: Use that directory.

- **If multiple exist**: **STOP** and ask the user which one to use.

Set **SKILLS_DIR** to the chosen directory (e.g., `.claude/skills/`).

**If none exists and the detected directory is NOT `.claude/skills/`**: Ask the user:

> "No existing skills directory found. Where would you like to install skills?
>
> 1. `.claude/skills/`
> 2. `{DETECTED_DIR}` (e.g., `.github/skills/`)"

Wait for the user's choice before proceeding.

## Step 4 - Download AlignFirst Skill

Create the skill directory:

```bash
mkdir -p {SKILLS_DIR}/alignfirst
```

**Important**: Use `curl -o "filename"` or `wget -O "filename"` to download files directly. Do NOT fetch file contents into your context.

Fetch the following files into `{SKILLS_DIR}/alignfirst/`:

- [SKILL.md](https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/main/skills/alignfirst/SKILL.md)
- [README.md](https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/main/skills/alignfirst/README.md)
- [spec-protocol.md](https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/main/skills/alignfirst/spec-protocol.md)
- [plan-protocol.md](https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/main/skills/alignfirst/plan-protocol.md)
- [do-protocol.md](https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/main/skills/alignfirst/do-protocol.md)
- [description-protocol.md](https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/main/skills/alignfirst/description-protocol.md)

## Step 5 - Post-Install Setup

1. Look at git branches (`git branch -a`) to detect the ticket ID format (e.g., `ABC-###`, `PROJ-###`, or numeric like `123`).

2. Check if `AGENTS.md` exists:

   - If it exists, ensure it contains: _"Always ignore the `_plans` directory when searching the codebase."_
   - If it doesn't exist, create `AGENTS.md` with:

     ```markdown
     # AI Agent Instructions

     Always ignore the `_plans` directory when searching the codebase.

     ## Ticket ID

     _Ticket ID_: Format is `{DETECTED_FORMAT}`. When not provided, deduce it from the branch name if possible—no need to confirm.
     ```

     If no ticket format was detected, ask the user for their format or skip the "Ticket ID" section.

3. Create `_plans/.gitkeep` if it doesn't exist:

   ```bash
   mkdir -p _plans && touch _plans/.gitkeep
   ```

4. Add to `.gitignore` if not already present:

   ```text
   _plans/*
   !_plans/.gitkeep
   ```

## Step 6 - Install Commands (Optional)

Follow the instructions in **[install-commands.md](https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/main/migrations/install-commands.md)**.

## Done

Tell the user that AlignFirst has been installed successfully, and point them to `{SKILLS_DIR}/alignfirst/README.md` for usage instructions.
