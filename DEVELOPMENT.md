# Development

The everyday workflow of this repository. Run `npm run docmap` for the design documentation.

## Stack and layout

An npm-workspaces monorepo of TypeScript packages (ESM only, `strict: true`), published under `@paleo/*`. Each package lives in `packages/<name>`; the OpenClaw coder material lives in `openclaw-coder/`, the agent skills in `skills/`. Lint and format with Biome, test with Vitest, release with Changesets.

## Worktrees

A workspace is a git worktree plus its setup: `.plans` and `.local` symlinked to the main worktree, `.vscode/settings.json` copied, then `npm install` and `npm run build`. This repository has no dev server, so the tooling runs portless: nothing to start, no `dev` script.

Create a workspace on a new branch, as a sibling directory of the main worktree:

```sh
npm run workspace -- setup -c 123/my-feature
```

Tear one down, keeping its branch:

```sh
npm run workspace -- remove <worktree-dir>
```

`npm run workspace -- list` shows every workspace; `npm run workspace -- --guide` documents the full procedures. The main worktree stays on `main`.

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
