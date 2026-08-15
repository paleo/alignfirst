# Development

The everyday workflow of this repository. Run `npm run docmap` for the design documentation.

## Stack and layout

An npm-workspaces monorepo of TypeScript packages (ESM only, `strict: true`), published under `@paleo/*`. Each package lives in `packages/<name>`; the OpenClaw coder material lives in `openclaw-coder/`, the agent skills in `skills/`. Lint and format with Biome, test with Vitest, release with Changesets.

## Worktrees

This repository has **no dev server**, so there is no workspace tooling: a workspace is simply a git worktree, managed with the standard git commands. Create one as a sibling of the main worktree:

```sh
git worktree add ../alignfirst-123-my-feature -b 123/my-feature
cd ../alignfirst-123-my-feature
ln -s ../alignfirst/.plans .plans
cp ../alignfirst/.vscode/settings.json .vscode/ 2>/dev/null || true
npm install && npm run build
```

The worktree is ready once these steps complete. `git worktree list` lists them; `git worktree remove <path>` tears one down. The main worktree stays on `main`.

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
| `npm run plans:sync` | Publish and retrieve the task plans (`.plans`) |
