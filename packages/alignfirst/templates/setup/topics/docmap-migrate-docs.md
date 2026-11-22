# Migrate Existing Documents

Bring an existing folder of Markdown documents to Docmap conventions: kebab-case names, and YAML frontmatter where it adds value. The conventions are in `{{CMD}} docmap --guide`. The migration happens in place unless the user names another target directory. The examples use `{{CMD}} docmap`; use the project's Docmap command (`{{CMD}} setup guide docmap`).

## 1. Explore

1. List every file and subdirectory of the target folder, recursively.
2. Check the file and directory names for kebab-case compliance.
3. Run `{{CMD}} docmap --check` for a report of naming issues and missing or broken frontmatter.
4. Summarize what needs to change: the files or directories to rename, the files that need frontmatter added or augmented, and the files already compliant.

Do not read any file. The tree and the `--check` output are enough for the discussion. File contents are read during execution: by subagents when the file count is large, or by you when it is small.

Skip `CHANGELOG.md` and `CHANGELOG*.md` files: never add or change their frontmatter.

## 2. Discuss

Present the findings to the user:

- The total file count, and how many files need changes.
- The proposed renames, old name to new name.
- The files that need frontmatter added or augmented.
- Any ambiguity that needs the user's decision, such as an unclear title or a questionable directory structure.

Obtain explicit approval before proceeding, and let the user adjust the plan.

## 3. Execute

### Rename

Rename every non-compliant file and directory to kebab-case. Rename directories before files, to avoid broken paths.

### Frontmatter

For each `.md` file except `CHANGELOG*.md`:

- **No frontmatter.** Read the whole file. Add frontmatter only when it adds value, with only the useful fields: `title` when the heading needs a better display name, `summary` when the title does not convey the purpose, `read_when` when the scope needs clarification.
- **Partial frontmatter.** Preserve every existing property; never remove or overwrite one. Add a missing field only when it adds value.
- **Complete frontmatter.** Leave it unchanged.

### Scale

- **Few files**, roughly what fits in your context: handle everything directly.
- **Many files**: split the work by subdirectory and delegate it to parallel subagents, one per subdirectory. Do not read any file content before delegating; only the subagents read files. Give each subagent the subdirectory path and its file listing, the renames and frontmatter changes for that subdirectory, and the Docmap frontmatter conventions.

## 4. Verify

Run `{{CMD}} docmap --check` on the migrated directory and show the output to the user. Confirm that every file passes.

## 5. Point agents at the essentials

In the documentation section of `AGENTS.md` or `CLAUDE.md`, add or refresh an `### Essential Documentation` sub-list naming the 1 to 3 documents an agent must always read first, such as the architecture and the code style. The section is the one `{{CMD}} setup guide docmap` selects: the standalone Docmap section or the AlignFirst bootstrap section. Keep the list short: it is the always-read subset, not the full index.
