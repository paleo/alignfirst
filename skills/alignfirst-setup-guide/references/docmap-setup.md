# Docmap Setup

Install the docmap CLI in a consumer repo so humans and agents share one set of docs under `docs/`.

## Install the CLI

1. **Use the package manager** identified in the skill's Shared Investigation Rules (fall back to npm).
2. **Add a `docmap` script** to the root `package.json`:

   ```json
   "docmap": "docmap"
   ```

3. **Install `@paleo/docmap`** as a dev dependency with the detected package manager: `npm install -D @paleo/docmap` (`pnpm add -D` / `yarn add -D` / `bun add -D`).
4. **Ensure a `docs/` directory** exists (`mkdir docs` if missing). When preparing a project for an
   AlignFirst Developer, populate a directory created here through
   [docmap-bootstrapping.md](docmap-bootstrapping.md); do not leave it empty.
5. **Add the docmap section** to `AGENTS.md` (or `CLAUDE.md`):

   ```markdown
   ## Docmap - Seek Documentation

   *Before* any investigation or code exploration, run `npm run docmap`, then read the relevant documentation. Mandatory for every task.

   ### Essential Documentation

   Always read before any investigation or work:

   - `docs/<doc>.md` — <one-line reason>
   ```

   The **Essential Documentation** sub-list names the 1–3 docs an agent must always read first (e.g. architecture, code style) — the always-read subset, not the full index. Populate it from the docs that already exist; if there are none yet, omit the sub-list for now — the bootstrap/migrate step below adds it once docs exist.

## Optional Documentation Work

1. Read authoring and browsing conventions by running `npm run docmap -- --guide`.
2. Continue only when the user also requested one of these documentation tasks:
   - [docmap-bootstrapping.md](docmap-bootstrapping.md) — create or extend documentation by exploring the codebase.
   - [docmap-migrate-existing-docs.md](docmap-migrate-existing-docs.md) — bring an existing docs folder into docmap conventions.
   - [docmap-migrate-skills.md](docmap-migrate-skills.md) — move internal knowledge from agent skills into `docs/`.
