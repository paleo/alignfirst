---
name: docmap
description: "Conventions for writing, organizing, and browsing documentation in a docs/ directory using docmap. Use when creating documents, restructuring documentation, or unsure about frontmatter format and file naming conventions."
license: CC0 1.0
metadata:
  author: Paleo
  version: "0.5.1"
  repository: https://github.com/paleo/alignfirst
---

# Authoring Documentation

All project documentation lives in the `docs/` directory. The `docmap` CLI lets both humans and AI agents discover and read documents without leaving the terminal.

## Browsing with CLI

> Run commands via the project's package manager (e.g. `npm run docmap --`, `pnpm docmap`, `yarn docmap`).

```bash
docmap                                          # list root docs
docmap --dir topic-a --dir topic-b/sub-topic-c  # list subdirectories
docmap --recursive                              # list everything
docmap --read doc-1.md --read topic-a/doc-2.md  # read documents (frontmatter stripped)
docmap --check                                  # validate all files
```

## Workflow

1. **Understand the Subject** — clarify what needs to be documented. Ask the user if unclear.
2. **Determine Placement** — scan existing docs (`docmap --recursive`). Decide: new file, existing file, which subdirectory. Discuss with the user if unclear.
3. **Write** — follow the conventions below.

## Writing Guidelines

- **Target audience:** an experienced newcomer — someone technically capable but unfamiliar with this specific project.
- Be brief and specific — no obvious information, no generic best practices.
- Typical document: 40–80 lines.
- Prefer referencing source files over large code blocks.
- If the title makes the purpose obvious, omit the `summary`.

## File and Directory Naming

- Use **lowercase-with-dashes** (kebab-case) for new files and directories.
- Uppercase is allowed by the CLI (e.g. `RELEASING.md`).
- Names must be **shell-safe**: no spaces, no quotes, no special characters. The CLI validates this for both files and directories. Use `docmap --check` to verify.
- Use `.md` (Markdown) for all documents.
- Use short, descriptive names.
- Group related documents into subdirectories. Subdirectories can be nested.

## YAML Frontmatter

`.md` files can start with a YAML frontmatter block. Add it when it adds value — especially when the filename or heading alone is not explicit enough. It is not required; when frontmatter is absent, the CLI falls back to the first `# heading` in the document body for the title. Fields:

| Field | Required | Description |
| --- | --- | --- |
| `title` | No | A human-readable display name shown in listings. Falls back to the first `# heading` when absent. |
| `summary` | No | One concise sentence. If the title already makes the purpose obvious, omit the summary to avoid redundancy. |
| `read_when` | No | A YAML list of short, action-oriented hints. Each hint completes: *"Read this document when you are…"* |

## Document Body

After the closing `---` of the frontmatter, write standard Markdown. There are no constraints on the body format — use headings, code blocks, tables, and lists as needed.

```markdown
---
title: Your Title Here
summary: A one-sentence description of what this document covers.
read_when:
  - first situation when this document is useful
  - second situation
---

# Your Title Here

Start your content here…
```

## References

- [Installing Docmap CLI](references/installation.md) — how to add docmap CLI to a project.
- [Bootstrapping Documentation](references/bootstrapping-documentation.md) — instructions for creating or extending project documentation by exploring the codebase.
- [Migrate Existing Documents](references/migrate-existing-docs.md) — guide for bringing an existing folder of Markdown documents into docmap conventions (naming, frontmatter).
- [Migrate Skills to Docmap Documentation](references/migrate-skills-to-docmap.md) — guide for moving internal project documentation from agent skills into `docs/`.
