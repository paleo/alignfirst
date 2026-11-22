# Migrate Skills to Documentation

Move internal project documentation from agent skills into `docs/`, and keep the genuinely reusable skills in place. The Docmap conventions are in `{{CMD}} docmap --guide`. The examples use `{{CMD}} docmap`; use the project's Docmap command (`{{CMD}} setup guide docmap`).

## 1. Find the skills directory

Look for these directories at the repository root:

- `.claude/skills/`
- `.codex/skills/`
- `.github/skills/`
- `.cursor/skills/`
- `.gemini/skills/`
- `.agent/skills/`

Ignore directories inside dependencies and build outputs: `node_modules/`, `vendor/`, `venv/`, `.venv/`, `target/`, `build/`, `dist/` and the like.

- **None exists**: stop, and tell the user there are no skills to migrate.
- **Exactly one exists**: use it.
- **Several exist**: ask the user which one to migrate.

The chosen directory is called SKILLS_DIR below.

## 2. Explore

1. List the directories in SKILLS_DIR.
2. List each skill directory recursively, to discover every file of every skill.

Do not read any file. Directory and file names are enough to classify each skill and propose a `docs/` layout. The subagents read the full content during the migration; reading it here wastes context and duplicates work.

Present the full file tree to the user before any decision.

## 3. Discuss

This is a collaborative discussion: present the findings and the proposed approach, then refine them with the user.

### Classify the skills

Each skill is either:

- **Internal documentation**: project-specific knowledge that belongs in `docs/`.
- **A reusable skill**: a generic method or protocol that stays a skill.

### Propose the `docs/` layout

- Follow the naming and frontmatter conventions of `{{CMD}} docmap --guide`.
- A skill's reference files become standalone documents, each with its own frontmatter.
- Group documents into subdirectories by content domain, such as `docs/backend/` and `docs/frontend/`.

Present the classification and the proposed hierarchy together. Ask clarifying questions, and let the user reshape the plan before proceeding.

### Create the structure

Once the user approves the layout, create its whole subdirectory hierarchy in `docs/`, without files, before any migration work.

## 4. Migrate

Do not read any skill file before delegating; only the subagents read them.

Delegate the conversion to parallel subagents, one per skill. Each subagent:

1. Reads the whole skill: `SKILL.md` and every reference file. This is the first time any skill content is read.
2. Chooses an approach. **Move and edit**: move the files to their target paths in `docs/`, rename them to kebab-case, then edit them in place. **Rewrite**: when the source is too tangled to edit cleanly, write the target files from scratch.
3. Adds frontmatter where it adds value: `title` when the heading needs a better display name, `summary` when the title does not convey the purpose, `read_when` when the scope needs clarification.
4. Deletes the original skill directory once all its files are migrated.

Give each subagent the skill directory path and its file listing, its target paths in `docs/` from the approved layout, and the Docmap frontmatter conventions.

## 5. Update the project configuration

### Agent instructions

When `AGENTS.md` or an equivalent top-level instruction file exists, use the documentation section and the installed command that `{{CMD}} setup guide docmap` selects. Preserve the AlignFirst bootstrap section when the project adopts the protocols or skills. Under the selected section, add:

```markdown
### Essential Documentation

Always read before any investigation or work:

- `docs/<doc>.md` — <one-line reason>
```

List the 1 to 3 documents an agent must always read first; the knowledge just migrated is a prime candidate. Keep it to the always-read subset, not the full index. Remove every reference to the deleted skill directories.

### `package.json`

Keep the installation selected in `{{CMD}} setup guide docmap`. Add a script only for the standalone package installed as a project dependency.

### Agent configuration files

When an agent configuration file, such as `CLAUDE.md`, `.claude/settings.json`, `.cursor/rules/` or `.github/copilot-instructions.md`, references a removed skill, point it to the new `docs/` file instead.

## 6. Verify

Run `{{CMD}} docmap --recursive` and show the output to the user. Confirm that every migrated document appears with the correct metadata.
