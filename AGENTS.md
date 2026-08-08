# Repository Guidelines

## Tooling

**Package manager**: npm workspaces (root `package.json` declares `"workspaces": ["packages/*"]`).

**Runtime**: Node (ESM only, `"type": "module"`).

**Language**: TypeScript with `strict: true`, `module: NodeNext`. Each package has a `tsconfig.build.json` (emits `dist/`) and a `tsconfig.json` (`noEmit`, includes `src` + `test`).

**Linter / formatter**: Biome (`biome.json` at root). `npm run lint` / `npm run lint:fix`.

**Test runner**: Vitest (`vitest run`). Per-package: `npm test --workspace <name>`. All packages: `npm test`.

**Releases**: Changesets (`.changeset/`). Author a changeset with `npm run changeset`; publish via `npm run changeset:publish`. Base branch: `main`. Default access: `public`.

**Workspace scripts** (root): `build`, `test`, `clear`, `lint`, `lint:fix` — all fan out to packages via `npm run <name> --workspaces --if-present`.

## Packages

- `@paleo/docmap` — lightweight documentation system for AI agents and humans
- `@paleo/openclaw-channel-mock-core` — shared library for synthetic OpenClaw channel plugins (bus, actions, factories)
- `@paleo/openclaw-slack-mock` — Slack-shaped channel plugin for test scenarios
- `@paleo/openclaw-discord-mock` — Discord-shaped channel plugin for test scenarios
- `@paleo/openclaw-test` — Dockerised regression-test harness (bus, scenario driver, judge, Compose stack)
- `@paleo/plans-repo` — share the `.plans` directory through a team plans repository
- `@paleo/workspace` — run multiple git-worktree dev environments side by side

## Docmap - Seek Documentation

*Before* any investigation or code exploration, run `npm run docmap`, then read the relevant documentation. Mandatory for every task.

## AlignFirst - Ticket ID, Commit Message, Branch Name

_Ticket ID_: Format is numeric. Use the ticket ID if explicitly provided. Otherwise, deduce it from the current branch name (no confirmation needed). If the branch name is unavailable, get it via `git branch --show-current`. Only ask the user as a last resort.

Commit message convention: we use conventional commit, e.g., `feat: add new feature`. Do not mention the ticket ID. Do not add a "Co-Authored-By:" line.

Branch naming convention: `<ticket-id>/<1-3-words>`.

Add the `top-down-typescript` skill to every plan.

## Skills to read before editing

- TypeScript or JavaScript file: read the `top-down-typescript` skill first (`.agents/skills/top-down-typescript/SKILL.md`).
- Markdown file (docs, skills, any prose): read the `sharp-writing` skill first (`.agents/skills/sharp-writing/SKILL.md`).

## Coding rules

Apply the `top-down-typescript` skill.

- Use UTF-8 encoding with 2-space indentation, 100-char line width.
- Use the semicolon syntax.
- Prefer double quotes `"`.
