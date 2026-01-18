# Update Skills

This prompt updates installed skills to the latest version. It also migrates old skill names (vibe-flow, documentation-authoring) to new names (alignfirst, technical-documentation-authoring).

> **Note**: Commands shown are Unix-style. Adapt to your OS if needed (e.g., PowerShell on Windows).

## Step 1 - Find Installed Skills

Search for installed skills in all possible locations. Look for directories containing:

- `alignfirst/SKILL.md` (new name)
- `vibe-flow/SKILL.md` (old name)
- `technical-documentation-authoring/SKILL.md` (new name)
- `documentation-authoring/SKILL.md` (old name)

Check these directories:

- `.claude/skills/`
- `.codex/skills/`
- `.github/skills/`
- `.cursor/skills/`
- `.gemini/skills/`
- `.agent/skills/`

**Important**: Ignore directories inside dependencies (`node_modules/`, `vendor/`, `venv/`, `.venv/`, `target/`, `build/`, `dist/`, etc.).

Note which skills are installed (old name, new name, or both) and their full paths. Record the **SKILLS_DIR** (parent directory of the skill folders). If no skills are found, tell the user and stop.

## Step 2 - Update AlignFirst Skill (if installed)

**Important**: Use `curl -o "filename"` or `wget -O "filename"` to download files directly. Do NOT fetch file contents into your context.

### If `alignfirst/SKILL.md` exists at path **{ALIGNFIRST_DIR}**:

Delete all existing files in the alignfirst directory, then fetch the latest versions into `{ALIGNFIRST_DIR}/`.

### If `vibe-flow/SKILL.md` exists at path **{VIBE_FLOW_DIR}** (old name):

1. Create the new directory: `mkdir -p {SKILLS_DIR}/alignfirst`
2. Fetch the latest versions into `{SKILLS_DIR}/alignfirst/`
3. Delete the old vibe-flow directory: `rm -rf {VIBE_FLOW_DIR}`

### Files to fetch:

- [SKILL.md](https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/main/skills/alignfirst/SKILL.md)
- [README.md](https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/main/skills/alignfirst/README.md)
- [spec-protocol.md](https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/main/skills/alignfirst/spec-protocol.md)
- [plan-protocol.md](https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/main/skills/alignfirst/plan-protocol.md)
- [do-protocol.md](https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/main/skills/alignfirst/do-protocol.md)
- [description-protocol.md](https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/main/skills/alignfirst/description-protocol.md)

## Step 3 - Update Technical Documentation Authoring Skill (if installed)

Use `curl -o "filename"` or `wget -O "filename"` to download files directly.

### If `technical-documentation-authoring/SKILL.md` exists at path **{TECH_DOC_DIR}**:

Delete all existing files in the directory, ensure `references/` subdirectory exists, then fetch the latest versions into `{TECH_DOC_DIR}/`.

### If `documentation-authoring/SKILL.md` exists at path **{DOC_AUTH_DIR}** (old name):

1. Create the new directory: `mkdir -p {SKILLS_DIR}/technical-documentation-authoring/references`
2. Fetch the latest versions into `{SKILLS_DIR}/technical-documentation-authoring/`
3. Delete the old documentation-authoring directory: `rm -rf {DOC_AUTH_DIR}`

### Files to fetch:

- [SKILL.md](https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/main/skills/technical-documentation-authoring/SKILL.md)
- [references/bootstrapping-skills.md](https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/main/skills/technical-documentation-authoring/references/bootstrapping-skills.md)

## Step 4 - Update Commands

First, delete old command files if they exist:

```bash
rm -f .claude/commands/spec.md .claude/commands/plan.md .claude/commands/dtdp.md .claude/commands/pr-message.md
```

Then, follow the instructions in **[install-commands.md](https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/main/migrations/install-commands.md)**.

## Done

Tell the user which skills were updated successfully and their locations. Mention if any skills were migrated from old names to new names.
