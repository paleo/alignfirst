# Docmap

Docmap serves the project's documentation tree under `docs/`. Choose one of two adoption forms; both expose the same tree.

## Through the AlignFirst CLI

Use this form when the project already uses the AlignFirst CLI. It adds no project dependency, and the README needs no installation instruction for it.

1. Ensure `docs/` exists. When preparing a project for an assistant, populate a newly created directory through `{{CMD}} setup guide docmap-bootstrap`.
2. Add the agent instructions below, with `{{CMD}} docmap` as the command.
3. Read the authoring guide with `{{CMD}} docmap --guide`.

Validate the documentation in CI with `{{CMD}} docmap --check`.

## Through `@alignfirst/docmap`

Use the standalone package when the project wants a local Docmap dependency or does not adopt AlignFirst.

1. Add the root script `"docmap": "docmap"` to `package.json`.
2. Install `@alignfirst/docmap` as a dev dependency with the project's package manager: `npm install -D`, `pnpm add -D`, `yarn add -D` or `bun add -D`.
3. Ensure `docs/` exists, and add the agent instructions below with the project's script command.
4. Read the authoring guide with `npm run docmap -- --guide`, translated for the package manager.

For a global installation, including in a project without `package.json`, run `npm install -g @alignfirst/docmap`. Ensure `docs/` exists, use `docmap` as the command in the agent instructions, and read `docmap --guide`. The project needs no dependency or script.

## Agent instructions

When the project adopts the AlignFirst protocols or skills, the `alignfirst context` bootstrap section replaces these instructions, whatever the Docmap installation; see `{{CMD}} setup guide protocols`.

Otherwise, read the existing `AGENTS.md` or `CLAUDE.md` before editing it. Insert this section as its first `##` section, after any frontmatter, `#` title or introduction:

```markdown
## Docmap - Seek Documentation

At the start of the session, before any investigation or code exploration, run `npm run docmap`. Then read the documentation relevant to the task.
```

Replace `npm run docmap` with the installed command:

| Installation | Command |
| --- | --- |
| npm script | `npm run docmap` |
| pnpm script | `pnpm docmap` |
| yarn script | `yarn docmap` |
| bun script | `bun run docmap` |
| Global standalone package | `docmap` |
| AlignFirst CLI | `{{CMD}} docmap` |

## Documentation work

Continue only when the user also requested one of these tasks:

- `{{CMD}} setup guide docmap-bootstrap`: create or extend the documentation by exploring the codebase.
- `{{CMD}} setup guide docmap-migrate-docs`: bring an existing docs folder to Docmap conventions.
- `{{CMD}} setup guide docmap-migrate-skills`: move internal knowledge from agent skills into `docs/`.
