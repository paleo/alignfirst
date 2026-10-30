# Developer Guide

The everyday workflow of this repository. Run `npm run docmap` for the design documentation.

## Stack and layout

An npm-workspaces monorepo of TypeScript packages (ESM only, `strict: true`), published under `@alignfirst/*`, plus the unscoped `alignfirst` and `aligndev`. Each package lives in `packages/<name>`; the AlignDev for OpenClaw tests live at the repository root, and agent skills live in `skills/`. Development uses Node 26, declared in `.nvmrc`. Lint and format with Biome, test with Vitest, release with Changesets.

## Workspaces

A workspace is a Git worktree plus its setup. `alignfirst.json` holds nested conventions, the explicit `developerInstructions: "DEVELOPERS.md"` reference and the recipe. Setup shares effective plans, usable untracked `.local` and harness artifacts, optionally seeds editor/harness settings, then finalizes with named `npm install` and `npm run build` steps. Runtime placement follows the companion registry; this checkout's retained state remains pending the upgrade below. This repository has no dev server or `dev` script.

Prepare ignored effective plans separately before workspace setup. From a fresh clone or linked worktree, run the published CLI without requiring local dependencies or build output:

```sh
npx -y alignfirst workspace setup
```

Setup installs dependencies and builds through the recipe's finalize steps. Run `npx -y alignfirst workspace --guide` for lifecycle procedures. Use `workspace remove` to clean up and delete a linked worktree while preserving its branch; `workspace teardown` cleans up while keeping the worktree.

Existing participating worktrees with old runtime registries, including the side-32 implementation session, remain pending an explicitly coordinated [upgrade](docs/upgrading-multi-stack-workspaces.md). Account for services/finalizers/resources across all worktrees before converting state. Reading configuration/context or syncing work files does not require lifecycle adoption; never test new lifecycle commands against that live old state.

## Conventions

- _Ticket ID_: numeric.
- _Branch naming_: `<ticket-id>/<1-3-words>` (e.g. `123/my-feature`).
- _Commit messages_: conventional commits, e.g. `feat: add new feature`. Do not mention the ticket ID.
- _Default branch_: `main`.

## Everyday commands

The tooling runs through the `alignfirst` CLI built in this workspace, so run `npm run build` first.

| Command | Purpose |
|---------|---------|
| `npm run build` | Build every package |
| `npm test` | Test every package (`npm test --workspace <name>` for one) |
| `npm run lint` / `npm run lint:fix` | Check / fix with Biome |
| `npm run docmap` | Browse the project documentation |
| `npm run workspace -- <command>` | Manage worktree workspaces (`--guide` for the procedures) |
| `npm run plans:sync` | Publish and retrieve the work files (`.plans`) |

In the main worktree, `.plans` is a symlink to the `alignfirst/` folder in a clone of the work-files repository. The folder is shared with the team and never committed here.

## Packaged acceptance

After building, run `npm run release:smoke -- --cli-only`. It installs checkout tarballs, including the workspace kernel, into an isolated CLI tree and exercises separate package-free disposable consumers. Python acceptance requires `python3` with stdlib `venv`; it uses no pip/network installer. The fixture proves two-package shared imports, virtual-environment/data/port isolation, a real HTTP API, a portless worker and Python content/transform/summary scripts. It does not exercise uv, FastAPI, Celery or Docker.

Run `BUN_BIN=$(command -v bun) npm run test:cli-runtimes` with Bun **1.4.4** and usable `bwrap`. Missing prerequisites fail acceptance rather than skip a tier. `CLI_RUNTIME_KEEP=1` retains disposable consumers; the runner prints the artifact directory with exact commands and executable/runtime/cwd audit records. The matrix covers Node/Bun launchers and installed-child finalize/stop/removal, restricted PATH and filesystem-proven Node absence. Project commands retain their selected toolchain independently of the CLI runtime. Harness checks use a fake Docker executable and offline native shims, not production services or providers.

## OpenClaw regression policy

After upgrades, select a few representative scenarios for the changed behavior. The full matrix is never the default. Investigate and fix unexpected errors before expanding coverage, and record the reason for any additional scenarios, surfaces or iterations. Conversation-model tests use Terra only; the judge uses Haiku through OpenRouter. See [Running the OpenClaw Tests](docs/aligndev-openclaw/running-openclaw-tests.md#scenario-selection) for selection and commands.
