# Docmap Setup

Choose one adoption form. Both expose the same documentation tree under `docs/`.

## Through the AlignFirst CLI

Use this form when the project already requires the AlignFirst CLI. It adds no project dependency.

1. Add `npm install -g alignfirst` to the README prerequisites.
2. Ensure `docs/` exists. When preparing a project for an AlignFirst Developer, populate a newly
   created directory through [docmap-bootstrapping.md](docmap-bootstrapping.md).
3. Add this section to `AGENTS.md` or `CLAUDE.md`:

   ```markdown
   ## Docmap - Seek Documentation

   *Before* any investigation or code exploration, run `alignfirst docmap`, then read the relevant documentation. Mandatory for every task.
   ```

4. Read the authoring guide with `alignfirst docmap --guide`.

CI can validate the documentation without relying on the machine's global version:

```sh
npx -y alignfirst@<range> docmap --check
```

## Through `@paleo/docmap`

Use the standalone package when the project wants docmap pinned in its lockfile or does not adopt
AlignFirst.

1. Add the root script:

   ```json
   "docmap": "docmap"
   ```

2. Install `@paleo/docmap` as a dev dependency with the detected package manager:
   `npm install -D @paleo/docmap` (`pnpm add -D`, `yarn add -D`, or `bun add -D`).
3. Ensure `docs/` exists and add the same instruction section, using `npm run docmap` for npm.
4. Read the authoring guide with `npm run docmap -- --guide`.

Translate the script commands for the detected package manager according to the skill's Shared
Investigation Rules.

## Documentation Work

Continue only when the user also requested one of these tasks:

- [docmap-bootstrapping.md](docmap-bootstrapping.md) — create or extend documentation by exploring
  the codebase.
- [docmap-migrate-existing-docs.md](docmap-migrate-existing-docs.md) — bring an existing docs folder
  into docmap conventions.
- [docmap-migrate-skills.md](docmap-migrate-skills.md) — move internal knowledge from agent skills
  into `docs/`.
