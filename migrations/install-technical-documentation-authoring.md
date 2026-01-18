# Install Technical Documentation Authoring Skill

This prompt installs the Technical Documentation Authoring skill in your project.

> **Note**: Commands shown are Unix-style. Adapt to your OS if needed (e.g., PowerShell on Windows).

## Step 1 - Check for Existing Installation

Search for an existing `technical-documentation-authoring` or `documentation-authoring` skill directory. Look for any directory containing `technical-documentation-authoring/SKILL.md` or `documentation-authoring/SKILL.md`.

**Important**: Ignore directories inside dependencies (`node_modules/`, `vendor/`, `venv/`, `.venv/`, `target/`, `build/`, `dist/`, etc.).

- If found, **STOP NOW** and tell the user:

  > "Technical Documentation Authoring (or Documentation Authoring) is already installed at `{PATH}`. To update it, use the update prompt instead:
  >
  > <https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/main/migrations/update-skills.md>"

- If not found, continue to Step 2.

## Step 2 - Detect Skills Directory

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

## Step 3 - Download Technical Documentation Authoring Skill

Create the skill directory and sub-directory:

```bash
mkdir -p {SKILLS_DIR}/technical-documentation-authoring/references
```

**Important**: Use `curl -o "filename"` or `wget -O "filename"` to download files directly. Do NOT fetch file contents into your context.

Fetch the following files into `{SKILLS_DIR}/technical-documentation-authoring/`:

- [SKILL.md](https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/main/skills/technical-documentation-authoring/SKILL.md)
- [references/bootstrapping-skills.md](https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/main/skills/technical-documentation-authoring/references/bootstrapping-skills.md)

## Done

Tell the user that Technical Documentation Authoring has been installed successfully.
