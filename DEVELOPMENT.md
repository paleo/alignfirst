# Development

The everyday workflow of this repository. Run `npm run docmap` for the design documentation.

## Stack and layout

An npm-workspaces monorepo of TypeScript packages (ESM only, `strict: true`), published under `@paleo/*`. Each package lives in `packages/<name>`; the AlignFirst Developer guide and tests live at the repository root, and agent skills live in `skills/`. Lint and format with Biome, test with Vitest, release with Changesets.

## Workspaces

A workspace is a git worktree plus its setup: `.plans` and `.local` symlinked to the main worktree, `.vscode/settings.json` copied, then `npm install` and `npm run build`. This repository has no dev server, so the tooling runs portless: nothing to start, no `dev` script.

Run `npm run workspace -- --guide` to learn the full procedures.

## Conventions

- _Ticket ID_: numeric.
- _Branch naming_: `<ticket-id>/<1-3-words>` (e.g. `123/my-feature`).
- _Commit messages_: conventional commits, e.g. `feat: add new feature`. Do not mention the ticket ID.
- _Default branch_: `main`.

## Everyday commands

| Command | Purpose |
|---------|---------|
| `npm run build` | Build every package |
| `npm test` | Test every package (`npm test --workspace <name>` for one) |
| `npm run lint` / `npm run lint:fix` | Check / fix with Biome |
| `npm run docmap` | Browse the project documentation |
| `npm run workspace -- <command>` | Manage worktree workspaces (`--guide` for the procedures) |
| `npm run plans:sync` | Publish and retrieve the task plans (`.plans`) |
