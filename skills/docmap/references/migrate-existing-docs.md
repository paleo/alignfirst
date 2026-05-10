# Migrate Existing Documents to Docmap Conventions

Bring an existing folder of Markdown documents into compliance with docmap conventions: kebab-case naming and YAML frontmatter on every file. The migration happens **in place** by default unless the user specifies a different target directory.

## Prerequisites

If this is a git repository, verify the working tree is clean. Do not proceed with uncommitted changes.

## Phase 1 — Explore

1. Recursively list all files and subdirectories in the target folder.
2. Check file and directory **names** for kebab-case compliance (no need to read file contents).
3. Run `docmap --check` to get a report of naming issues and missing or broken frontmatter.
4. Build a summary of what needs to change:
   - Files or directories that need renaming.
   - Files that need frontmatter added or augmented.
   - Files that are already compliant.

**Do not read any file.** The file tree and `docmap --check` output provide all the information needed for the discussion phase. File contents will be read later during execution — by subagents when the file count is large, or by you for small counts.

**Special files**: Skip `CHANGELOG.md` and `CHANGELOG*.md` files — do not add or modify their frontmatter.

## Phase 2 — Discuss

Present findings to the user:

- Total file count and how many need changes.
- List of proposed renames (old name -> new name).
- List of files needing frontmatter additions or augmentation.
- Any ambiguities or decisions that need user input (e.g., unclear titles, questionable directory structure).

Get explicit approval before proceeding. Let the user adjust the plan.

## Phase 3 — Execute

### Rename files and directories

Apply kebab-case renaming to all non-compliant files and directories. Rename directories before files to avoid broken paths.

### Add or augment frontmatter

For each `.md` file (except `CHANGELOG*.md`):

- **No frontmatter exists**: Read the full file content and add frontmatter only when it adds value — i.e. when the filename or heading alone is not explicit enough. Only include fields that are useful: `title` when the heading needs a better display name, `summary` when the purpose isn't obvious from the title, `read_when` when the document's scope needs clarification. Files without frontmatter are valid — the CLI falls back to the first `# heading` for the title.
- **Partial frontmatter exists**: Preserve all existing properties — do not remove or overwrite them. Only add a missing field if it would add value (e.g. add `summary` if the title alone doesn't convey the document's purpose; add `read_when` if the scope needs clarification).
- **Complete frontmatter exists**: Leave it unchanged.

### Scaling strategy

- **Small number of files** (roughly fits in context): You handle everything directly.
- **Large number of files**: Split the work by subdirectory and delegate to subagents (the Task tool) running in parallel. Each subagent handles one subdirectory and its contents. You must **not** read any file content before delegating — only the subagents read file contents. You provide each subagent with:
  - The subdirectory path and its file listing
  - The list of renames and frontmatter changes for that subdirectory
  - The docmap frontmatter conventions

## Phase 4 — Verify

Run `docmap --check` on the migrated directory and show the output to the user. Confirm all files pass validation.
