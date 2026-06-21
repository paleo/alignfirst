# Migrate Skills to Docmap Documentation

Move internal project documentation from agent skills into `docs/` with proper YAML frontmatter, while keeping genuinely reusable skills in place.

## Prerequisites

If this is a git repository, verify the working tree is clean. Do not proceed with uncommitted changes.

## Phase 1 — Detect Skills Directory

Search for existing `skills/` directories in the repository root:

- `.claude/skills/`
- `.codex/skills/`
- `.github/skills/`
- `.cursor/skills/`
- `.gemini/skills/`
- `.agent/skills/`

**Important**: Ignore directories inside dependencies (`node_modules/`, `vendor/`, `venv/`, `.venv/`, `target/`, `build/`, `dist/`, etc.).

**Decision:**

- **If none exists**: Stop and tell the user there are no skills to migrate.
- **If exactly one exists**: Use that directory.
- **If multiple exist**: Ask the user which one to migrate.

Set **SKILLS_DIR** to the chosen directory.

## Phase 2 — Explore

1. List all directories in SKILLS_DIR.
2. For each skill directory, list its contents **recursively** to discover every file in every skill.

**Do not read any file.** Directory and file names are sufficient to classify each skill and propose a `docs/` layout. The full content will be read later by subagents during the migration phase. Reading files here wastes context and duplicates work.

Present the full file tree to the user so they can see what exists before any decisions are made.

## Phase 3 — Discuss

This is a collaborative discussion, not a rubber-stamp. Present your findings and proposed approach, then work with the user to refine it.

### Classify Skills

For each skill, determine whether it is:

- **Internal documentation**: Project-specific knowledge that belongs in `docs/`.
- **Reusable skill**: Generic methodology or protocol that should stay as a skill.

### Propose `docs/` Layout

Rules for the layout:

- Every file and directory name is **lowercase with dashes**.
- Add YAML frontmatter when it adds value — especially when the filename or heading alone is not explicit enough. Files without frontmatter are valid; the CLI falls back to the first `# heading` for the title. Only include fields that are useful: omit `summary` if the title is self-explanatory, omit `read_when` if the document's scope is obvious.
- `read_when` is a YAML list of short action-oriented hints telling the agent when to read the document.
- Reference files from skills become standalone documents with their own frontmatter.
- Propose subdirectories based on content domains (e.g., `docs/backend/`, `docs/frontend/`).

Present both the classification and the proposed `docs/` hierarchy together. Ask clarifying questions. Let the user reshape the plan before proceeding.

### Create Directory Structure

Once the user approves the layout, create the entire hierarchy of subdirectories in `docs/` (empty directories, no files yet). This ensures the target structure is in place before any migration work begins.

## Phase 4 — Migrate

**Important:** You must **not** read any skill file content before delegating. Only the subagents read the files.

Delegate the conversion work using subagents (the Task tool), **one instance per skill**, running in parallel. Each subagent:

1. **Reads the skill entirely** — `SKILL.md` and all reference files. This is the first time any skill content is read.
2. **Decides on the approach** — depending on complexity:
   - **Move and edit**: Move files to their target paths in `docs/`, rename to kebab-case, then edit in place to add/replace YAML frontmatter and make content edits.
   - **Rewrite**: When the source is too tangled to edit cleanly, write the target file(s) from scratch.
3. **Adds frontmatter** to target files when it adds value — `title` when the heading needs a better display name, `summary` when the purpose isn't obvious from the title, `read_when` when the document's scope needs clarification.
4. **Deletes the original skill directory** after all its files have been migrated.

You must provide each subagent with:

- The skill directory path and its file listing
- The target path(s) in `docs/` (from the approved layout)
- The docmap frontmatter conventions

## Phase 5 — Update Project Configuration

### AGENTS.md (or equivalent)

If `AGENTS.md` (or an equivalent top-level agent instructions file) exists, add or replace the documentation discovery section with the following.

_**Note**: Adapt the `npm run docmap` command to the project's package manager (`pnpm docmap`, `yarn docmap`, `bun run docmap`)._

> ## Docmap - Seek Documentation
>
> **Before any investigation or code exploration**, run `npm run docmap`, then read the relevant documentation. Mandatory for every task.

Remove any references to the deleted skill directories.

### package.json

If a root `package.json` exists and does not already have a `docmap` script, add it:

```json
"docmap": "docmap"
```

### Agent Configuration Files

If any agent configuration file (e.g., `CLAUDE.md`, `.claude/settings.json`, `.cursor/rules/`, `.github/copilot-instructions.md`) references the removed skills, update those references to point to the new `docs/` files instead.

## Phase 6 — Verify

Run `docmap --recursive` and show the output to the user. Confirm all migrated documents appear with correct metadata.
