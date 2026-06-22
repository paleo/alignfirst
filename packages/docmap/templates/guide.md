# Authoring Documentation

All project documentation lives in the `docs/` directory. The `docmap` CLI lets humans and AI agents discover and read documents without leaving the terminal.

## Browsing with CLI

Targets are positional paths; the CLI classifies each by inspecting the filesystem (directory → list, file → read). Pass several at once. The `docs/` prefix shown in listings is optional on input.

```bash
{{COMMANDS}}
```

## Workflow

1. **Understand the subject** — clarify what to document. Ask the user if unclear.
2. **Determine placement** — scan existing docs (`{{PM_ARGS}} --recursive`). Decide: new file, existing file, or subdirectory. Discuss if unclear.
3. **Write** — follow the conventions below.

## Writing Guidelines

- **Audience:** an experienced newcomer — technically capable but unfamiliar with this project.
- Be brief and specific — no obvious information, no generic best practices.
- Typical document: 40–80 lines.
- Prefer referencing source files over large code blocks.
- If the title makes the purpose obvious, omit the `summary`.

## File and Directory Naming

- Use **lowercase-with-dashes** (kebab-case) for new files and directories.
- Uppercase is allowed (e.g. `RELEASING.md`).
- Names must be **shell-safe**: no spaces, quotes, or special characters. Verify with `{{PM_ARGS}} --check`.
- Use `.md` for all documents.
- Use short, descriptive names.
- Group related documents into subdirectories; nesting is allowed.

## YAML Frontmatter

`.md` files may start with a YAML frontmatter block. Add it when it adds value — especially when the filename or heading alone is not explicit enough. It is optional; when absent, the CLI falls back to the first `# heading` for the title.

| Field | Required | Description |
| --- | --- | --- |
| `title` | No | Display name shown in listings. Falls back to the first `# heading` when absent. |
| `summary` | No | One concise sentence. Omit when the title already makes the purpose obvious. |
| `read_when` | No | A YAML list of short, action-oriented hints. Each completes: *"Read this document when you are…"* |

## Document Body

After the closing `---`, write standard Markdown — headings, code blocks, tables, lists as needed.

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
