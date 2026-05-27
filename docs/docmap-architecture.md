---
title: Docmap Architecture
summary: How docmap works internally — source structure, CLI flow, frontmatter parsing, and output formatting.
read_when:
  - onboarding to the docmap codebase
  - understanding how the CLI processes docs
  - adding a new CLI option or changing output format
  - debugging frontmatter parsing or validation
---

# Architecture

Docmap is a CLI tool that turns a `docs/` directory of YAML-frontmatted Markdown files into a browsable documentation system. Inspired by [OpenClaw](https://github.com/openclaw/openclaw/)'s `scripts/docs-list.js` — specifically its hand-rolled frontmatter parser and the `read_when`/`summary`/`title` pattern — with no external runtime dependencies.

## Source Structure

Three TypeScript modules in `packages/docmap/src/`, compiled to `packages/docmap/dist/` via `tsc`:

| Module | Responsibility |
| --- | --- |
| `src/parser.ts` | YAML frontmatter extraction (`extractMetadata`) and stripping (`stripFrontmatter`). |
| `src/formatter.ts` | Directory reading, listing/formatting, name validation, `--check`, and file resolution (`readDocFile`, direct path then fuzzy basename search; returns `undefined` when nothing resolves). |
| `src/cli.ts` | Argument parsing, flow orchestration, package-manager detection for tips. |

Entry point: `packages/docmap/bin/docmap.mjs` → imports `packages/docmap/dist/cli.js` → calls `main()` → returns an exit code.

## CLI Flow

`main()` in `src/cli.ts` drives everything:

1. **Parse args** — `parseArgs()` extracts `--recursive`, `--root`, `--check`, collects positional **paths**, and collects unknown `--flags`. Tokens starting with `--` are never paths; an unknown one is recorded and later warned about on stderr (so a stale `docmap --dir topic-a` still works — `--dir` is skipped, `topic-a` is a positional). `parseArgs` is pure (no writes).
2. **Resolve base directory** — `--root` or default `docs/` relative to `cwd`. The **display prefix** is `relative(cwd, baseDir)` — `docs` by default, or the root's path for a custom `--root` (e.g. `config/docs`, or `../shared` outside cwd). All displayed paths carry this prefix, so they stay real and openable; the empty prefix (root === cwd) yields bare paths.
3. **`--check`** → `checkAll()` validates every file and directory name (shell-safe regex) and every `.md` frontmatter. Returns exit code 1 if any issues. (Only `--check` returns non-zero.)
4. **Classify positionals** — each path is normalized (trailing slashes stripped, leading display prefix removed; the bare prefix → root), resolved under the base dir, then `statSync`-tested. Existing directory → listing bucket; everything else (existing file, or missing) → read bucket. `statSync` throwing on a missing path is caught and treated as "not a directory". The filesystem is the source of truth — no extension heuristic.
5. **Listings** — produced for each directory-classified path via `listDirectory()`/`formatDirectory()` or `formatRecursive()`. With no positionals at all, or with `--recursive` and no directory positionals, the root is listed. Files-only with `--recursive` off produces no listing.
6. **Reads** — each read-bucket path goes through `readDocFile()` (direct path, then fuzzy basename search). A resolved result is wrapped in `<document_file>` tags; an unresolved one becomes a single generic `⚠ Not found: <path>` line (same wording for a mistyped file or directory — classification can't read intent, and a not-found read keeps exit code 0). Reads follow listings, separated by a blank line.
7. **Tip** — After a listing, one contextual tip (`formatTip`) is appended explaining that several paths can be passed at once; the example shows directory args only when subdirs exist and file args (carrying the display prefix) only when files exist. The package manager is auto-detected from lockfiles.

## Frontmatter Contract

A YAML frontmatter block (`---` delimiters) is optional. The parser in `src/parser.ts` is hand-rolled (no YAML library):

- Finds the closing `\n---` after the opening `---`.
- Extracts `title` (string), `summary` (string), `read_when` (list of `- item` entries).
- Strips surrounding quotes from values.
- Returns an `error` string for unterminated frontmatter (opened but never closed). Missing frontmatter is not an error.

`title` is optional. When absent (no frontmatter, or frontmatter without `title`), `extractFallbackTitle` scans the document body for the first `# heading` (skipping fenced code blocks). `summary` and `read_when` are recommended but not enforced by `--check`.

## Formatting and Output

Listing output is Markdown:

- **Flat listing** (`formatDirectory`) — `# Title`, optional `## Sub-directories` tree, then file bullets.
- **Recursive listing** (`formatRecursive`) — Heading level increases with depth (`#`, `##`, `###`…).
- **File bullets** — `` - `docs/path/file.md` — Title `` with optional `**Summary:**` and `**Read when:**` lines below.

Warnings (⚠) appear inline for name issues or frontmatter errors.

## Validation

`--check` mode (`checkAll` in `src/formatter.ts`) recursively walks the docs tree and reports:

- **Name issues** — Files or directories with spaces or special characters (must match `/^[\w.-]+$/`).
- **Frontmatter issues** — Missing or unterminated frontmatter blocks.

`CHANGELOG*.md` files are always skipped.

## Development

| Command | Purpose |
| --- | --- |
| `npm -w @paleo/docmap run build` | Compile TypeScript (`src/` → `dist/`) |
| `npm -w @paleo/docmap test` | Run tests with Vitest |
| `npm run lint` | Biome linter (root) |

Tests live in `packages/docmap/test/docmap.test.ts` and use fixture directories under `packages/docmap/test/fixtures/` (basic, errors, empty, nested, bad-names, subdirs-only). Each fixture is a self-contained `docs/`-like tree passed via `--root`.

## Agent Skill

The `skills/docmap/` directory ships a reusable agent skill that teaches AI agents how to use docmap, write documents, install it in a project, bootstrap a `docs/` directory, and migrate documentation from skills. It is distributed separately from the npm package.
