# Docmap Setup

Choose one adoption form. Both expose the same documentation tree under `docs/`.

## Through the AlignFirst CLI

Use this form when the project already requires the AlignFirst CLI. It adds no project dependency.

1. Nothing to install: project files invoke `npx alignfirst`. Offer `npm install -g alignfirst` in the README as a convenience.
2. Ensure `docs/` exists. When preparing a project for a claw, populate a newly
   created directory through [docmap-bootstrapping.md](docmap-bootstrapping.md).
3. Add the **Agent Instructions** below, using `npx -y alignfirst docmap` as the Docmap command.
4. Read the authoring guide with `npx alignfirst docmap --guide`.

CI can pin a version range while validating the documentation:

```sh
npx -y alignfirst@<range> docmap --check
```

## Through `@alignfirst/docmap`

Use the standalone package when the project wants docmap pinned in its lockfile or does not adopt
AlignFirst.

1. Add the root script:

   ```json
   "docmap": "docmap"
   ```

2. Install `@alignfirst/docmap` as a dev dependency with the detected package manager:
   `npm install -D @alignfirst/docmap` (`pnpm add -D`, `yarn add -D`, or `bun add -D`).
3. Ensure `docs/` exists and add the **Agent Instructions** below, using the project's script command.
4. Read the authoring guide with `npm run docmap -- --guide`.

Translate the script commands for the detected package manager according to the skill's Shared
Investigation Rules.

### Global installation

For a global installation, including projects without `package.json`, run `npm install -g @alignfirst/docmap`. Ensure `docs/` exists, use `docmap` in the instructions below, and read `docmap --guide`. No project dependency or script is needed.

## Agent Instructions

For Docmap without AlignFirst skills or protocols, add this section to `AGENTS.md` or `CLAUDE.md`, before every other section whenever possible:

```markdown
## Docmap - Seek Documentation

*Before* any investigation or code exploration, run `npm run docmap`, then read the relevant documentation. Mandatory for every task.
```

Replace `npm run docmap` with the installed command:

| Installation | Command |
| --- | --- |
| npm script | `npm run docmap` |
| pnpm script | `pnpm docmap` |
| yarn script | `yarn docmap` |
| bun script | `bun run docmap` |
| Global standalone package | `docmap` |
| AlignFirst CLI | `npx -y alignfirst docmap` |

When the project adopts AlignFirst skills or protocols, use the [AlignFirst context section](alignfirst-skills-setup.md#project-instructions) instead. It replaces `Docmap - Seek Documentation` regardless of how Docmap is installed. Preserve any essential-documentation list and project-specific instructions.

## Documentation Work

Continue only when the user also requested one of these tasks:

- [docmap-bootstrapping.md](docmap-bootstrapping.md) — create or extend documentation by exploring
  the codebase.
- [docmap-migrate-existing-docs.md](docmap-migrate-existing-docs.md) — bring an existing docs folder
  into docmap conventions.
- [docmap-migrate-skills.md](docmap-migrate-skills.md) — move internal knowledge from agent skills
  into `docs/`.
