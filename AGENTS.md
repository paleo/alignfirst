# Repository Guidelines

## Seek project conventions and documentation

Run `npx -y alignfirst context` once from the repository root, _before_ any investigation or code exploration. It prints the project conventions, the documentation map, and the AlignFirst protocols.

## Tooling

**Package manager**: npm workspaces (root `package.json` declares `"workspaces": ["packages/*"]`).

**Runtime**: Node (ESM only, `"type": "module"`).

**Language**: TypeScript with `strict: true`, `module: NodeNext`. Each package has a `tsconfig.build.json` (emits `dist/`) and a `tsconfig.json` (`noEmit`, includes `src` + `test`).

**Linter / formatter**: Biome (`biome.json` at root). `npm run lint` / `npm run lint:fix`.

**Test runner**: Vitest (`vitest run`). Per-package: `npm test --workspace <name>`. All packages: `npm test`.

**Model-test policy**: Run model-driven matrices with Terra first. Once green, run the smallest
representative Sonnet compatibility check. Expand Sonnet coverage only to diagnose a
Sonnet-specific failure.

**Releases**: Changesets (`.changeset/`). Base branch: `main`. Default access: `public`. Publishing runs from CI through npm trusted publishing — see `docs/releasing.md`.

**Workspace scripts** (root): `build`, `test`, `clear`, `lint`, `lint:fix` — all fan out to packages via `npm run <name> --workspaces --if-present`.

This repository is on *GitHub*.

## Packages

- `alignfirst` — the AlignFirst CLI: protocols, work files and docs
- `@alignfirst/alcode` — coding agent wrapper for the AlignFirst Dev Kit
- `@alignfirst/alproject` — project inventory and port allocation for the AlignFirst Dev Kit host
- `@alignfirst/docmap` — lightweight documentation system for AI agents and humans
- `@alignfirst/service-openclaw-plugin` — OpenClaw plugin for an assistant, under plugin ID `alignfirst-service`
- `@alignfirst/openclaw-channel-mock-core` — shared library for synthetic OpenClaw channel plugins (bus, actions, factories)
- `@alignfirst/openclaw-slack-mock` — Slack-shaped channel plugin for test scenarios
- `@alignfirst/openclaw-discord-mock` — Discord-shaped channel plugin for test scenarios
- `@alignfirst/openclaw-test` — Dockerised regression-test harness (bus, scenario driver, judge, Compose stack)
- `@alignfirst/workspace` — run multiple git-worktree dev environments side by side

## Workspaces

A **workspace** is a git worktree (with its branch) plus its own dev setup: symlinked shared directories and seeded config files. Workspaces are isolated, so you can work on several branches in parallel. This repository has no dev server, so the system runs portless: nothing to start, no `dev` script.

Run `npm run workspace -- --guide` for the full procedures.

## Skills to read before editing

- TypeScript or JavaScript file: read the `top-down-typescript` skill first (`.agents/skills/top-down-typescript/SKILL.md`).
- Markdown file (docs, skills, any prose): read the `sharp-writing` skill first (`.agents/skills/sharp-writing/SKILL.md`).

## Coding rules

Apply the `top-down-typescript` skill.

- Use UTF-8 encoding with 2-space indentation, 100-char line width.
- Use the semicolon syntax.
- Prefer double quotes `"`.
