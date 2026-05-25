# Repository Guidelines

**Important:** Every text in this repository must be sharp, concise, straight to the point. Each word must be carefully weighted and chosen.

**Writing Markdown**: Do not wrap text to 80 chars; let it run freely.

## Tooling

**Package manager**: npm workspaces (root `package.json` declares `"workspaces": ["packages/*"]`).

**Runtime**: Node (ESM only, `"type": "module"`).

**Language**: TypeScript with `strict: true`, `module: NodeNext`. Each package has a `tsconfig.build.json` (emits `dist/`) and a `tsconfig.json` (`noEmit`, includes `src` + `test`).

**Linter / formatter**: Biome (`biome.json` at root). `npm run lint` / `npm run lint:fix`.

**Test runner**: Vitest (`vitest run`). Per-package: `npm test --workspace <name>`. All packages: `npm test`.

**Releases**: Changesets (`.changeset/`). Author a changeset with `npm run changeset`; publish via `npm run changeset:publish`. Base branch: `main`. Default access: `public`.

**Workspace scripts** (root): `build`, `test`, `clear`, `lint`, `lint:fix` — all fan out to packages via `npm run <name> --workspaces --if-present`.

## AlignFirst - Ticket ID, Commit Message, Branch Name

_Ticket ID_: Format is numeric. Use the ticket ID if explicitly provided. Otherwise, deduce it from the current branch name (no confirmation needed). If the branch name is unavailable, get it via `git branch --show-current`. Only ask the user as a last resort.

Commit message convention: we use conventional commit, e.g., `feat: [#123] add new feature`. Always prefix the ticket ID with a `#` sign. Do not add a "Co-Authored-By:" line.

Branch naming convention: `<type>/<ticket-id>` (with type from conventional commit, e.g., `feat/123`, `fix/123`, `refactor/123`, `chore/123`).

Add `paleo-typescript-style` skill to every plan.

## Coding rules

Apply the `paleo-typescript-style` skill.

- Use UTF-8 encoding with 2-space indentation, 100-char line width.
- Use the semicolon syntax.
- Prefer double quotes `"`.

## Packages

- `@paleo/docmap` — lightweight documentation system for AI agents and humans
- `@paleo/openclaw-channel-mock-core` — shared library for synthetic OpenClaw channel plugins (bus, actions, factories)
- `@paleo/openclaw-slack-mock` — Slack-shaped channel plugin for test scenarios
- `@paleo/openclaw-discord-mock` — Discord-shaped channel plugin for test scenarios
- `@paleo/openclaw-test` — Dockerised regression-test harness (bus, scenario driver, judge, Compose stack)
- `@paleo/worktree-env` — worktree-based concurrent local environment kernel
