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
| `src/cli.ts` | Argument parsing, flow orchestration, package-manager detection, and help/guide rendering (the `--guide` body is read from `templates/guide.md`). |

Entry point: `packages/docmap/bin/docmap.mjs` → imports `packages/docmap/dist/cli.js` → calls `main()` → returns an exit code.

The `--guide` text lives as Markdown in `packages/docmap/templates/guide.md` with three placeholders: `{{PM}}` for a bare invocation, `{{PM_ARGS}}` for one that forwards arguments, and `{{COMMANDS}}` for the rendered "Browsing with CLI" command block. `{{PM}}` and `{{PM_ARGS}}` differ only for npm, whose `run` script needs a `--` separator before args (`npm run docmap` vs `npm run docmap --`); every other manager forwards args verbatim, so both resolve to the same command. `renderGuide()` reads the file via `new URL("../templates/guide.md", import.meta.url)` — the path resolves from both `src/cli.ts` (dev/test) and `dist/cli.js` (published), each one level under the package root — and substitutes all three tokens. `templates/` is listed in `package.json` `files` so it ships with the package.

Help and guide command lists are built from shared `CommandRow[]` builders (`browseCommands`, `moreCommands`, `guideCommands`) and rendered through one `renderCommands()` helper that pads each command to the group's longest, so the `#` comments stay vertically aligned for any package-manager prefix. Short help, full help (`Commands:` + `More:`), and the guide's `{{COMMANDS}}` block all flow through it; each group aligns independently.

## CLI Flow

`main()` in `src/cli.ts` drives everything:

1. **Parse args** — `parseArgs()` extracts the mode flags `--help`, `--guide`, `--search <terms>`, `--recursive`, `--root <path>`, `--check`, collects positional **paths**, and collects unknown `--flags`. `--search` consumes the next token as its value (same shape as `--root`); without a following token it is recorded as unknown. Tokens starting with `--` are never paths; an unknown one is recorded and later warned about on stderr (so a stale `docmap --dir topic-a` still works — `--dir` is skipped, `topic-a` is a positional). `parseArgs` is pure (no writes).
2. **Resolve base directory** — `--root` or default `docs/` relative to `cwd`. The **display prefix** is `relative(cwd, baseDir)` — `docs` by default, or the root's path for a custom `--root` (e.g. `config/docs`, or `../shared` outside cwd). All displayed paths carry this prefix, so they stay real and openable; the empty prefix (root === cwd) yields bare paths.
3. **Mode dispatch** — modes are tried in precedence and each returns early after printing only its own output: `--help` (full help) → `--guide` (authoring guide) → `--search` (path + frontmatter match) → `--check` (validation) → listing/read. `--help`/`--guide`/`--search` always return `0`; only `--check` can return `1`. Help and guide text is rendered from the auto-detected package manager so every shown command is copy-pasteable.
4. **`--search`** → `searchDocs()` walks the tree (`collectAllFiles`), reads each file, and keeps the ones whose joined `relative-path + title + summary + read_when` text contains every whitespace-split term (case-insensitive; body text is not searched). Including the relative path means a basename or directory segment matches even when absent from frontmatter. Matches render as file bullets, or a single `No documents match: <terms>` line.
5. **Classify positionals** — each path is normalized (trailing slashes stripped, leading display prefix removed; the bare prefix → root), resolved under the base dir, then `statSync`-tested. Existing directory → listing bucket; everything else (existing file, or missing) → read bucket. `statSync` throwing on a missing path is caught and treated as "not a directory". The filesystem is the source of truth — no extension heuristic.
6. **Listings** — produced for each directory-classified path via `listDirectory()`/`formatDirectory()` or `formatRecursive()`. With no positionals at all, or with `--recursive` and no directory positionals, the root is listed. A **bare** invocation (no positionals, none of `--recursive`/`--check`/`--help`/`--guide`/`--search`) lists recursively when the tree holds fewer than 20 `.md` files (`collectAllFiles` count), and is the only case prefixed with short help; at ≥20 it keeps the top-level listing. An explicit `--recursive` is unaffected. Files-only with `--recursive` off produces no listing.
7. **Reads** — each read-bucket path goes through `readDocFile()` (direct path, then fuzzy basename search). A resolved result is wrapped in `<document_file>` tags; an unresolved one becomes a single generic `⚠ Not found: <path>` line (same wording for a mistyped file or directory — classification can't read intent, and a not-found read keeps exit code 0). Reads follow listings, separated by a blank line.
8. **Tip** — After a listing, one contextual tip (`formatTip`) is appended explaining that several paths can be passed at once; the example shows directory args only when subdirs exist and file args (carrying the display prefix) only when files exist. The package manager is auto-detected from lockfiles, falling back to bare `docmap` when no lockfile is found.

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

Tests live in `packages/docmap/test/docmap.test.ts` and use fixture directories under `packages/docmap/test/fixtures/` (basic, errors, empty, nested, bad-names, subdirs-only, classify, no-frontmatter, large). Each fixture is a self-contained `docs/`-like tree passed via `--root`. The `large` fixture (≥20 `.md` files) exercises the top-level listing kept above the recursive-default threshold.

## Authoring Guide and Setup

The authoring conventions (frontmatter contract, naming, workflow) ship with the CLI as `templates/guide.md`: `docmap --guide` prints that file, rendered with the project's package-manager prefix. Project setup — bootstrapping a `docs/` tree, wiring docmap into a repo, and migrating existing docs or skills — lives in the separate `alignfirst-setup-guide` skill, distributed outside the npm package.
