# @paleo/docmap

A lightweight documentation system for AI agents and humans. Keep project docs in a `docs/` folder with YAML frontmatter, browse and read them from the terminal.

The CLI lists, reads, and validates docs, and ships its own authoring guide: run `docmap --guide` to learn the conventions for writing and organizing documents.

_Inspired by the [OpenClaw](https://github.com/openclaw/openclaw/) docs system, which uses [Mintlify](https://www.mintlify.com/). This project doesn't depend on Mintlify._

## Installation

Install the CLI as a dev dependency and add a `docmap` script:

```bash
npm install -D @paleo/docmap
```

In your `package.json`:

```json
{
  "scripts": {
    "docmap": "docmap"
  }
}
```

In your `AGENTS.md` or `CLAUDE.md` file:

```md
## Docmap - Seek Documentation

**Before any investigation or code exploration**, run `npm run docmap`, then read the relevant documentation. Mandatory for every task.
```

### Bootstrapping a docs/ directory

To bootstrap a `docs/` directory, wire docmap into a project, and migrate existing docs or skills, install the `alignfirst-setup-guide` skill temporarily and let an agent drive the setup:

```bash
npx skills add https://github.com/paleo/alignfirst --skill alignfirst-setup-guide
```

Then ask your agent:

```md
Use your *alignfirst-setup-guide* skill. What are my options for bootstrapping a `docs/` directory in this project?
```

## How It Works

1. Uses a `docs/` directory at your project root.
2. All files and directories are preferably named in **kebab-case**.
3. Lists any readable text file: Markdown, plain text, diagrams-as-text (`.dsl`, `.mermaid`, `.drawio`), markup (`.xml`, `.html`), data (`.json`, `.yaml`, `.csv`, `.toml`), and schemas (`.sql`, `.graphql`, `.proto`, `.prisma`). Binary formats such as PDF or images are excluded, so a text asset like `docs/architecture/c4-model.dsl` shows up beside your docs while a `report.pdf` does not. Config templates are included too — `.env.example` (and `.sample`/`.template`/`.dist` variants, so `config.yaml.example` lists as well) — while a live `.env` holding secrets is never listed or read.
4. `.md` files can start with YAML frontmatter. Add it when it adds value (e.g. when the filename or heading alone isn't explicit enough):

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

## Global Installation

Install the CLI globally to run it from anywhere:

```bash
npm install -g @paleo/docmap
```

Then invoke it directly:

```bash
docmap -v
```

## CLI

Run the CLI from the project directory that contains your `docs/` directory.

```bash
# Short help, then the listing (lists recursively when the doc set is small)
docmap

# Full help
docmap --help

# Authoring guide (conventions for writing documents)
docmap --guide

# List one or more subdirectories
docmap dir-a
docmap dir-a dir-b

# List everything recursively
docmap --recursive

# Read one or more documents (frontmatter stripped)
docmap docs/dir-a/doc-1.md
docmap docs/dir-a/doc-1.md docs/dir-b/doc-2.md

# Mix directories and files in one call
docmap dir-a docs/dir-b/doc-2.md

# Search path and frontmatter (title, summary, read_when); every term must match
docmap --search "api endpoint"

# Validate all files (names, frontmatter)
docmap --check

# Use a custom docs root instead of docs/
docmap --root path/to/docs
```

A bare invocation lists recursively when the tree holds fewer than 20 documents, and falls back to a top-level listing above that threshold. An explicit `--recursive` always walks the whole tree.

### Classification

Each positional path is resolved against the docs root:

- **Existing directory** → listed (honoring `--recursive`).
- **Existing file** → read (Markdown files have their frontmatter stripped; other files are served verbatim).
- **Neither** → a fuzzy basename search over listable files (so `database.md` resolves from anywhere in the tree). No match → a single `⚠ Not found: <path>` line.

Listings display each path prefixed with the docs root **relative to your working directory**: `docs/…` by default, or whatever `--root` points to (e.g. `--root config/docs` shows `config/docs/…`). That prefix is optional on input and trailing slashes are tolerated: `docs/dir-a/`, `docs/dir-a`, and `dir-a` resolve identically
