# @paleo/docmap

A lightweight documentation system for AI agents and humans. Keep project docs in a `docs/` folder with YAML frontmatter, browse and read them from the terminal.

Docmap is both an **npm package** (this CLI — lists, reads, and validates docs) and an **agent skill** `docmap` — conventions and workflows that teach AI agents how to write, organize, and migrate documentation). You need both: the package provides the tooling, the skill provides the knowledge.

_Inspired by the [OpenClaw](https://github.com/openclaw/openclaw/) docs system, which uses [Mintlify](https://www.mintlify.com/). This project doesn't depend on Mintlify._

## Installation

Start by installing the skill:

```bash
npx skills add https://github.com/paleo/alignfirst --skill docmap
```

> **Note:** We recommend installing the docmap skill locally in each project.

Start a new session, then ask your agent to do its magic:

```text
Use your docmap skill. Install docmap CLI in this project.
```

## How It Works

1. Uses a `docs/` directory at your project root.
2. All files and directories are preferably named in **kebab-case**.
3. `.md` files can start with YAML frontmatter. Add it when it adds value (e.g. when the filename or heading alone isn't explicit enough):

```markdown
---
title: Your Title Here
summary: A short description of what this document covers.
read_when:
  - first situation when this document is useful
  - second situation
---

# Your Title Here

...
```

| Field | Required | Description |
| --- | --- | --- |
| `title` | No | Display name shown in listings. Falls back to the first `# heading` in the document body when absent. |
| `summary` | No | Short description. Omit if the title is self-explanatory. |
| `read_when` | No | When to consult this document. Omit if the scope is obvious. |

## CLI

```bash
# List root-level documents
npx docmap

# List a subdirectory
npx docmap --dir topic-a

# List multiple subdirectories
npx docmap --dir topic-a --dir topic-b

# List everything recursively
npx docmap --recursive

# Read one or more documents (frontmatter stripped)
npx docmap --read docs/topic-a/doc-1.md
npx docmap --read docs/topic-a/doc-1.md --read docs/topic-b/doc-2.md

# Validate all files (names, frontmatter)
npx docmap --check

# Use a custom docs root instead of docs/
npx docmap --root path/to/docs
```

### Options

| Option | Description |
| --- | --- |
| `--dir <subdir>` | List documents in a subdirectory. Repeatable. |
| `--recursive` | Walk the entire tree. Combinable with `--dir`. |
| `--read <file>` | Print document contents (frontmatter stripped). Repeatable. |
| `--check` | Validate all files and directories. Reports name and frontmatter issues. |
| `--root <path>` | Use a custom directory as the docs root instead of `docs/`. |

For internals, see [docs/docmap-architecture.md](../../docs/docmap-architecture.md).
