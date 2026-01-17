# Upgrade to Agent Skills

This migration converts your AlignFirst (or Vibe Flow) v1 installation from the `_docs/` system to the Agent Skills standard.

**Reference**: <https://agentskills.io/specification.md>

> **Note**: Commands shown are Unix-style. Adapt to your OS if needed (e.g., PowerShell on Windows).

## Pre-requisites

- Verify `_docs/alignfirst/` or `_docs/vibe-flow/` exists. If neither exists, STOP - this codebase is not an AlignFirst/Vibe Flow v1 installation.
- If this is a git repository, verify the working tree is clean. DO NOT PROCEED with uncommitted changes.

## Install the AlignFirst Skill

### 1. Delete Old AlignFirst/Vibe Flow Files

```bash
rm -rf _docs/alignfirst _docs/vibe-flow
```

### 2. Detect Skills Directory

Search for existing `skills/` directories in the repository root:

- `.claude/skills/`
- `.codex/skills/`
- `.github/skills/`
- `.cursor/skills/`

**Decision:**

- **If none exists**: Determine the installation directory based on the current agent:
  - Claude Code → `.claude/skills/`
  - Codex → `.codex/skills/`
  - GitHub Copilot → `.github/skills/`
  - Cursor → `.cursor/skills/`
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

### 3. Download AlignFirst Skill

Create the skill directory and fetch the latest files from the repository:

```bash
mkdir -p {SKILLS_DIR}/alignfirst
```

**Important**: Use `curl -o "filename"` or `wget -O "filename"` to download files directly. Do NOT fetch file contents into your context.

Fetch the following files into `{SKILLS_DIR}/alignfirst/`:

- [README.md](https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/main/skills/alignfirst/README.md)
- [SKILL.md](https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/main/skills/alignfirst/SKILL.md)
- [spec-protocol.md](https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/main/skills/alignfirst/spec-protocol.md)
- [plan-protocol.md](https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/main/skills/alignfirst/plan-protocol.md)
- [do-protocol.md](https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/main/skills/alignfirst/do-protocol.md)
- [description-protocol.md](https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/main/skills/alignfirst/description-protocol.md)

### 4. Install Commands

First, delete old command files:

```bash
rm -f .claude/commands/spec.md .claude/commands/plan.md .claude/commands/dtdp.md .claude/commands/pr-message.md .claude/commands/doc.md .claude/commands/al.md .claude/commands/alspec.md .claude/commands/alplan.md .claude/commands/aldescription.md
```

Then, follow the instructions in **[install-commands.md](https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/main/migrations/install-commands.md)**.

### 5. Clean AGENTS.md

Remove all references to `_docs/alignfirst/` and `_docs/vibe-flow/` files from `AGENTS.md`. This includes references to:

- `AlignFirst Guide.md` or `Vibe Flow Guide.md`
- `How to Write a Technical Specification.md`
- `How to Write Implementation Plans.md`
- `How to Write a Description.md`
- `Discuss-Then-Do Protocol.md` or `Align-and-Do Protocol.md`

Remove the entire "AlignFirst" or  "Vibe Flow" section if it becomes empty after removing these references.

## Detect Legacy Documentation Skill

Check if `_docs/Writing Documentation.md` exists. If it does:

1. Delete it:

   ```bash
   rm -f "_docs/Writing Documentation.md"
   ```

2. Set **INSTALL_TECH_DOC_SKILL** = true (this will trigger installation of the replacement skill at the end)

## Convert Documentation to Skills

This section requires a discussion with the user to determine how to organize documentation into skills.

### 1. List Available Documentation

List all `.md` files in `_docs/` (excluding `Unused Instructions.md`). Present them to the user.

### 2. Suggest Groupings

Analyze the documentation files and suggest logical groupings. For example:

- Multiple plugin-related docs → one `work-on-plugin` skill with reference files
- Architecture/overview docs → one `architecture` skill

**Important**: By default, these files should be separate skills (unless the user says otherwise):

- `Code Style Guidelines.md` → `code-style` skill
- `Code Quality & Refactoring.md` → `code-quality` skill
- `How to Write Unit Tests.md` → `testing` skill

Present your suggestions to the user and ask:

> "Here are the documentation files I found. I suggest grouping them as follows:
>
> - **{skill-name}**: {file1.md}, {file2.md} - {brief description of when to use this skill}
> - **{skill-name}**: {file3.md} - {brief description}
>
> Would you like to proceed with these groupings, or do you have a different organization in mind?"

### 3. Create Skills Based on User Decision

_**Important**: It's better to move files (using `mv`) than reproduce their content, since the markdown/xml-tags syntax can sometimes be altered during the reproduction. Also, most of the time, you don't need to fill your context with their content._

For each skill the user wants to create:

1. Create the skill directory:

   ```bash
   mkdir -p "{SKILLS_DIR}/{skill-name}"
   ```

2. Create `SKILL.md` in `{SKILLS_DIR}/{skill-name}/`:

   If there is a primary documentation file, then move it as `SKILL.md`. Otherwise, create an empty `SKILL.md`. The `SKILL.md` will be completed at step 4.

3. Move additional reference files (if any) with kebab-case names:

   ```bash
   mv "_docs/{Other File}.md" "{SKILLS_DIR}/{skill-name}/{other-file}.md"
   ```

4. Edit `SKILL.md` to add the required structure:

   - Prepend YAML frontmatter with `name` and `description` fields
   - If the skill has reference files, add a "Reference Files" section listing each file with a brief description

   Example of a complete `SKILL.md`:

   ```markdown
   ---
   name: work-on-plugin
   description: Guidelines for developing plugins. Use when creating, modifying, or debugging plugins.
   ---

   # Plugin Development

   (original content here)

   ## Reference Files

   - [plugin-architecture.md](plugin-architecture.md) - Technical details of the plugin system
   - [plugin-api.md](plugin-api.md) - API reference for plugin development
   ```

_Note: Only include the "Reference Files" section if there are reference files. Place it as the first `##` section in the document._

### 4. Handle Unused Instructions

If `_docs/Unused Instructions.md` exists, leave it in place. The `_docs/` directory will be kept with only this file inside.

### 5. Clean AGENTS.md

1. Remove all references to `_docs/` files
2. Remove empty sections (sections with no content after removing references)
3. Keep only:
   - Project name/title
   - "Always ignore the `_plans` directory when searching the codebase"
   - Ticket ID format (in "Ticket ID" or "For AI Assistants" section) if present
   - Any project-specific instructions not related to documentation

### 6. Delete Old Structure

If `_docs/Unused Instructions.md` exists, keep the `_docs/` directory but delete everything else inside it:

```bash
find _docs -type f ! -name "Unused Instructions.md" -delete
find _docs -type d -empty -delete
```

Otherwise, delete the entire directory:

```bash
rm -rf _docs
```

## Install Technical Documentation Authoring Skill

If **INSTALL_TECH_DOC_SKILL** is true:

1. Create the skill directory:

   ```bash
   mkdir -p {SKILLS_DIR}/technical-documentation-authoring/references
   ```

2. Fetch the skill files using `curl -o "filename"` or `wget -O "filename"`:

   - [SKILL.md](https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/main/skills/technical-documentation-authoring/SKILL.md) → `{SKILLS_DIR}/technical-documentation-authoring/SKILL.md`
   - [references/bootstrapping-skills.md](https://raw.githubusercontent.com/paleo/alignfirst/refs/heads/main/skills/technical-documentation-authoring/references/bootstrapping-skills.md) → `{SKILLS_DIR}/technical-documentation-authoring/references/bootstrapping-skills.md`

## Report to User

Summarize:

- AlignFirst skill installed
- Number of additional skills created from documentation
- List of all skill names
- If **INSTALL_TECH_DOC_SKILL** was true: mention that `Writing Documentation.md` was replaced by the `technical-documentation-authoring` skill
- Remind user that skills are auto-discovered by agents
- Note: If Ticket ID was not preserved, suggest running the alignfirst post-install setup
