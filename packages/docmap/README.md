# @paleo/docmap

A lightweight documentation system for AI agents and humans. Keep project docs in a `docs/` folder with YAML frontmatter, browse and read them from the terminal.

Docmap is both a **npm package** (this CLI; it lists, reads, and validates docs) and an **agent skill** `docmap` (conventions and workflows that teach AI agents how to write, organize, and migrate documentation). You need both: the package provides the tooling, the skill provides the knowledge.

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

Targets are **positional arguments**. The CLI inspects the filesystem and classifies each one itself — a directory is listed, a file is read — so you never have to pre-declare which is which.

```bash
# List root-level documents
npx @paleo/docmap

# List one or more subdirectories
npx @paleo/docmap topic-a
npx @paleo/docmap topic-a topic-b

# List everything recursively
npx @paleo/docmap --recursive

# Read one or more documents (frontmatter stripped)
npx @paleo/docmap docs/topic-a/doc-1.md
npx @paleo/docmap docs/topic-a/doc-1.md docs/topic-b/doc-2.md

# Mix directories and files in one call
npx @paleo/docmap topic-a docs/topic-b/doc-2.md

# Validate all files (names, frontmatter)
npx @paleo/docmap --check

# Use a custom docs root instead of docs/
npx @paleo/docmap --root path/to/docs
```

### Classification

Each positional path is resolved against the docs root:

- **Existing directory** → listed (honoring `--recursive`).
- **Existing file** → read, frontmatter stripped. Any extension is accepted; an extensionless file works too.
- **Neither** → a fuzzy basename search over `.md` files (so `database.md` resolves from anywhere in the tree). No match → a single `⚠ Not found: <path>` line.

Listings display each path prefixed with the docs root **relative to your working directory** — `docs/…` by default, or whatever `--root` points to (e.g. `--root config/docs` shows `config/docs/…`). That prefix is optional on input and trailing slashes are tolerated: `docs/topic-a/`, `docs/topic-a`, and `topic-a` resolve identically — so listing output can be pasted straight back as arguments.

### Options

| Option | Description |
| --- | --- |
| `--recursive` | Walk the entire tree. Applies to directory listings (root or positional). |
| `--check` | Validate all files and directories. Reports name and frontmatter issues. |
| `--root <path>` | Use a custom directory as the docs root instead of `docs/`. |

Unknown `--flags` are warned about on stderr and skipped; stdout stays clean. A leftover `docmap --dir topic-a` therefore still works — `--dir` is skipped and `topic-a` is treated as a positional directory.

For internals, see [docs/docmap-architecture.md](https://github.com/paleo/alignfirst/blob/main/docs/docmap-architecture.md).
