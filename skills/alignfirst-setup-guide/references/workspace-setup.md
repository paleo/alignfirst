# Implementing Worktree-Based Concurrent Local Environments

Blueprint for a **workspace** system — multiple git-worktree dev environments side by side. Requires git. The templates are Node.js, but the approach fits any runtime.

**Node consumers** install `@paleo/workspace` and write two thin wrappers — `workspace.mjs` and `dev-server.mjs` — that build a config object and call `runWorkspace(config)` / `runDevServer(config)`. The package owns the kernel (slot/dev-server registries, port math, branch lifecycle, process control, log polling, CLI). You supply project callbacks (`finalizeWorktree`, `printSummary`, optional `purgeInfrastructure`) plus a `configFiles` list.

**Non-Node consumers** reimplement the system from this design; the concept sections are self-contained.

The `assets/` scripts ([workspace.mjs](../assets/workspace.mjs), [dev-server.mjs](../assets/dev-server.mjs)) are annotated references. Each field carries an `ADAPT` comment. Copy a script, fill in the `ADAPT` points, then **strip the scaffolding comments** — keep only the rare comment explaining a non-obvious project choice. Aim for lean wrappers.

**The operating surface is self-documented.** `workspace --guide` (rendered in the project's package manager) lists every command, flag, recovery path, and the directory layout. Read it; don't restate it, and point agents at it (see [Agent Instructions](#agent-instructions)). Kernel internals (foreground self-exit, cross-worktree stop, orphan healing) are the package's concern — setup needs only the callback contracts below.

This document is the **setup tutorial**: the decisions you make, and how to wire the two wrappers.

## Implementation Process

Apply in order. The per-project decisions live in the [checklist](#checklist); this section is the sequence and its guardrails.

1. **Require a clean working tree.** Run `git status` first. If it isn't clean, stop and ask the developer to commit or stash. Testing commits scaffolding and creates/removes worktrees and branches — safe and reviewable only from a clean baseline.
2. **Investigate.** Read this doc, then inspect the repo to answer every checklist item: current ports and config files, shared vs per-worktree gitignored directories, database provisioning, package manager, and the dev-server's ready / fatal log markers. Note what needs migrating (scattered ports, a config file not yet gitignored, a colliding dev-script name).
3. **Present findings and plan, then get approval.** Base port and scheme, the shared / per-worktree split, config files to patch, database strategy, dev-server command (and any rename), migrations. **Change nothing until the developer agrees.**
4. **Implement.** Work the checklist: install the package, write the two wrappers, add the npm scripts, migrate ports / config, update `.gitignore`, write the agent docs.
5. **Commit once, then test.** Make a **single commit** with all the scaffolding — a prerequisite for testing, not a wrap-up: `workspace setup -c <branch>` builds the linked worktree from the committed `HEAD`, so the scripts and `package.json` changes must be committed to exist there. Then exercise the CLI end to end (the command sequence is in `workspace --guide`): bootstrap the main worktree, create a throwaway workspace, start / stop dev servers, `list` and `status`, remove the throwaway, then delete the test branch you created — your own artifact, the one case where deleting a branch is expected.
6. **Fix by amending.** When a test surfaces a problem, fix it, fold it into the same commit with `git commit --amend`, and re-test. Keep the whole effort as one commit.
7. **Never push.** Leave the final, amended commit for the developer to review and push.

## Core Concepts — the Decisions

### Shared vs per-worktree gitignored directories

For each gitignored directory, decide: **shared** across worktrees, or **isolated** per worktree?

- **Shared** directories are symlinked to the main worktree — things that should be the same everywhere: the slot registry, personal notes, task plans.
- **Per-worktree** directories are created fresh in each worktree — things that must differ: databases, caches, logs, Docker volumes.

| Directory      | Kind               | Contents                      |
| -------------- | ------------------ | ----------------------------- |
| `.local/`      | Shared (symlinked) | Slot registry, personal notes |
| `.plans/`      | Shared (symlinked) | Task planning files           |
| `.local-wt/`   | Per-worktree       | Databases, caches, logs       |

Setup symlinks the shared directories and creates fresh per-worktree ones. A shared directory missing from the main worktree is created there first, so every symlink resolves. The names are customizable.

The main worktree's `.plans` may itself be a symlink — into a clone of a team plans repository (see [plans-share-setup.md](plans-share-setup.md)); the symlink chain resolves on its own.

### Contiguous port scheme

Most projects scatter ports (server 3000, db 5432, frontend 5173). The system needs **all ports configurable and reorganized into a contiguous range** derived from one slot number. E.g. 3000 / 5432 / 5173 → 8100 / 8101 / 8102 in the main worktree, and 8110 / 8111 / 8112 in slot 8110. A one-time migration.

**Choose a base port that starts a range of at least 200 contiguous ports free on all common operating systems.** 8100 is a safe default (8100–8299). Steer a user away from 8000 — it collides with common HTTP alternates on some systems.

Docker services can remap the host port without touching the container's internal port.

### Slot-based allocation

Each worktree gets a **slot** — identified by its primary port number (e.g. `--slot 8120`). A JSON **slot registry** in a shared directory tracks slot → worktree. The template ships 19 linked slots plus the implicit main worktree = 20 workspaces. A step of 10 between slots leaves room for several ports per environment (frontend 8110, server 8111). A single-port project can use a step of 1 (drop `PORT_STEP`, the modulo check in `isValidPort()`, and any secondary-port derivation).

Registry (under the main worktree's `runtimeDir`, e.g. `.local-wt/workspace-registry/slots.json`):

```json
{ "slots": { "8110": { "worktree": "/abs/path/myproject-feat-214", "status": "ready", "createdAt": "2026-01-01T00:00:00.000Z" } } }
```

The main worktree sits at `basePort`; linked worktrees at `basePort + portStep × k` for k ≥ 1.

### Concurrent dev-server cap

Host RAM is shared; parallel dev-servers can exhaust it. Pass `devLimit` to `runDevServer` (omit for no limit). `5` is a sensible default — bump it for a light stack, lower it for a heavy one. A second registry, `dev-servers.json`, tracks live servers; at the cap, `dev` / `dev up` aborts and lists the active servers (re-run with `--evict` to stop the oldest and proceed).

### Config files: gitignored, and **all** of them

Config files carrying ports (`.env`, `docker-compose.yml`, …) **must be gitignored**: worktrees share one git history, so a tracked config would be identical everywhere, defeating per-worktree ports.

`configFiles` seeds a gitignored file into each new worktree, then patches it per slot. It is **not only for port-bearing files** — it is for **every gitignored file a worktree needs to function**. Each entry declares where its initial content comes from via `source.kind`:

- `{ kind: "mainWorktree" }` — copy the file at the same path from the main worktree. The common case: the developer's customized config flows into every sibling.
- `{ kind: "newWorktree", path }` — copy a committed template (e.g. an `.example`) from the new worktree's own checkout, so it tracks the branch.
- `{ kind: "content", content }` — an inline string, or a sync/async function returning one.

`patch(content, { slot, ports, mainWorktree, currentWorktree })` rewrites the content per slot; **omit it to copy verbatim**:

- **Port-bearing** files patch the slot's ports in: use `helpers.patchEnvFile` for `KEY=VALUE` files, and `helpers.extractHost` to preserve a non-localhost host (a main-worktree `API_URL=http://1.2.3.4:8001` stays `http://1.2.3.4:<newPort>` rather than collapsing to localhost).
- **Verbatim** files need no `patch`. These are the easy ones to forget, and the usual cause of a half-broken linked worktree: editor settings (`.vscode/settings.json`), a secondary `.env`, a private-registry token (`.npmrc`), a package's own env file, etc. **List every one** — a missing entry means the linked worktree silently lacks that file.
- Set `optional: true` for a file that may legitimately be absent at its source; it then warns and skips instead of aborting.

**Two-stage flow** (the `mainWorktree` source). (1) Once per repo, the main worktree's actual config is created from its `.example` and customized. (2) For every sibling, setup copies the main worktree's config and patches the ports — so main-worktree customizations (a public dev IP, secrets, feature flags) flow in for free. Trade-off: mistakes in the main config propagate too; keep it clean. A consumer who prefers example-derived configs uses a `newWorktree` source (`{ kind: "newWorktree", path: "...example" }`), usually behind a developer-local toggle so the choice stays per-developer.

**Automate stage 1 with `preSetup`** (see the [field contract](#workspacemjs)). Done by hand, stage 1 is the step a fresh clone has never run — so its first `workspace setup` aborts with `config source … not found` the moment a `mainWorktree`-sourced config is missing. The `preSetup` hook runs before `configFiles` are copied: on `isMainWorktree`, seed each gitignored config from its committed `.example` when absent. A fresh clone then sets up with zero manual steps, and siblings still inherit the customized main config through `configFiles`.

## Writing the Two Wrappers

The assets annotate every field; read them as you fill in the `ADAPT` points. This section is the contract those annotations assume.

### `workspace.mjs`

Builds a `WorkspaceConfig` and calls `runWorkspace`. Key fields:

- `scriptPath` / `devServerScript` — absolute paths; leave the `import.meta.url` lines as-is (the package re-spawns the script for the detached finalize phase, and shells out to the dev-server script on removal).
- `basePort`, `portStep` (default 10), `maxSlotCount` (default 19), and either `portNames` (consecutive ports) or `ports(slot)` (full control).
- `sharedDirs` (symlinked from main), `runtimeDir` (per-worktree; holds logs and the registry).
- `configFiles: Array<{ path, source, patch?, optional? }>` — one entry per gitignored file (see above). `source` (required) is `{ kind: "mainWorktree" }`, `{ kind: "newWorktree", path }`, or `{ kind: "content", content }`. `patch(content, { slot, ports, mainWorktree, currentWorktree })` rewrites per slot; omit it to copy verbatim.
- `preSetup({ isMainWorktree, currentWorktree, mainWorktree, force, log })` — optional; runs **before** `configFiles` are copied. Bootstrap source files the kernel will look for — typically seed the main worktree's gitignored config from its committed `.example` so a fresh clone's first `workspace setup` works with no manual step. **MUST be idempotent**; on a linked-worktree setup it MUST NOT mutate the main worktree, so gate the bootstrap on `isMainWorktree` (`force` mirrors `--force` for re-seeding). Omit it when every `configFile` uses a `newWorktree` or `content` source (nothing to bootstrap).
- `finalizeWorktree(ctx)` — the detached background step: infrastructure startup, DB readiness wait, install / build, migrations, seed. **MUST be idempotent** — `workspace setup` is the documented retry path and re-runs it; idempotency also covers an orphan-and-reuse of the slot (force-remove a stale slot-named container before `up`). **Run `npm install` first**, so any later failure still leaves usable `node_modules/` for the retry to import `@paleo/workspace`. May `return { extra }` — an opaque blob persisted on the slot and handed to `purgeInfrastructure`; use it **only** for teardown identifiers you can't re-derive at purge time (deterministic container / volume names come from slot + paths, so they don't go here).
- `purgeInfrastructure(ctx)` — optional destructive teardown (typically `docker compose down -v`). Runs on `workspace remove`, `prune`, and orphan removal. **MUST be idempotent and cwd-independent**: `ctx.worktree` may be gone (orphan), so branch on its presence and tear down *by name* in that case — derive names from `ctx.slot` / `ctx.worktree` / `ctx.mainWorktree`, and read `ctx.extra` for non-derivable ids. Swallow errors.
- `printSummary(ctx)` — returns the post-setup string. Don't list dev-server URLs; the dev-server isn't running yet at this point.

### `dev-server.mjs`

Builds a `DevServerConfig` and calls `runDevServer`. `servers: ServerDescriptor[]` — one entry per server, conceptually one dev server. Discriminated on `kind`:

- `kind: "spawn"` — `{ name, exec, port, detectSuccess, detectError? }`. The runner spawns the process, logs to `<runtimeDir>/logs/<name>.log`, polls the log for readiness, and tracks the PID. Read `port` from your config with `helpers.readPortFromEnvFile(file, varName)` / `helpers.readPortFromJsonFile(file, jsonPath)`. `detectError` (optional) fails fast on a known fatal log pattern.
- `kind: "callback"` — `{ name, start(ctx), stop(ctx) }`. You own the lifecycle; declare infrastructure (Docker, DB) here, typically first. Servers start in array order, stop in reverse.

`kind: "callback"` rules (not type-enforced — read carefully):

- `start(ctx)` resolves only once the resource is ready (no log polling on the runner's side).
- Let a failing command throw (run with `stdio: "inherit"`, or print `err.stderr` on `"pipe"`). Never swallow it — a false success starts later servers against a dead dependency and hides the root cause.
- Thread `ctx.cwd` into every child process and resolve every path against it. Never call bare `execSync("docker compose …")` — it picks up `process.cwd()` and breaks cross-worktree stop.
- Resolve everything inside the callback, not at module load.

Also: `devLimit` (the cap), optional `printSummary({ slot, servers })`.

### Database provisioning

Each worktree needs its own database; how is project-specific. The setup must end with a working DB.

- **File-based (SQLite, etc.):** copy the data directory from the main worktree — the simplest case.
- **Docker (PostgreSQL, MySQL, etc.):** copy `docker-compose.yml` (as a `configFile`, patching the host port and a slot-scoped `container_name` so containers don't collide), `docker compose up -d`, wait for readiness, run migrations, run the seed.

**Postgres readiness gotcha:** poll `pg_isready -h 127.0.0.1` (a TCP check), not a plain probe. On a fresh volume, Postgres first runs a throwaway Unix-socket-only server for `initdb` that answers a socket-side `pg_isready` too early; gating on TCP — which that init server doesn't listen on — stops the next step from connecting to it and losing the connection on handoff.

### npm scripts to add

```json
{ "workspace": "node scripts/workspace/workspace.mjs", "dev": "node scripts/workspace/dev-server.mjs" }
```

The single `dev` script carries every subcommand. Don't name it after the app's own dev command — a spawn server running `npm run dev` would recurse; use a distinct name (e.g. `dev:app`).

## Agent Instructions

The system only works if agents know about it. The CLI self-documents via `workspace --guide`, so wire just two things: a pointer to that command, and the facts the CLI can't know.

### Main instruction file (`AGENTS.md` / `CLAUDE.md`)

- **Conventions that affect workspaces** — branch naming and commit message conventions, because the agent creates branches:

  ```markdown
  Branch naming convention: `<type>/<ticket-id>` (e.g., `feat/123`).
  Commit message convention: conventional commits, e.g., `feat: [#123] add new feature`.
  ```

- **A workspaces section** pointing at the guide:

  ```markdown
  ## Workspaces

  A **workspace** is a git worktree (with its branch) plus its own dev setup: dedicated ports, config files, a database, and a dev server you can bring up or down. Workspaces are isolated, so you can run several branches in parallel.

  Run `npm run workspace -- --guide` for the full procedures.
  ```

- **A search-ignore line** so agents skip gitignored runtime dirs. List `runtimeDir` (e.g. `.local-wt`), and `.local` only if your repo uses it. Extend an existing line rather than duplicate:

  ```markdown
  Always ignore the `.local-wt`, `.plans` directories when searching the codebase.
  ```

### Project-specific facts the guide can't know

Record only repo-specific facts, in whatever entry point developers and agents already read (`README.md`, `AGENTS.md`, `DEVELOPMENT.md`):

1. **URLs to open after `dev` starts** (admin UI, auto-login), with the dynamic port.
2. **Release process** if it lives near the dev workflow (changeset rules, PR/MR target).
3. **Any project quirk** — extra build steps, a non-obvious log path.

## Checklist

- [ ] **Make all dev ports configurable and contiguous.** Prerequisite.
- [ ] **Design the port scheme.** Ports per environment? Step between slots? Base port 8100 unless you have a reason.
- [ ] **Identify your config files.** Every gitignored file a worktree needs — port-bearing *and* verbatim (editor settings, secondary `.env`, private-registry tokens). Do they have `.example` versions?
- [ ] **Classify gitignored directories.** Shared (symlinked) vs per-worktree.
- [ ] **Decide database provisioning.** File copy (SQLite) or Docker + migrate + seed.
- [ ] **Decide the dev-server ready marker** and **fatal markers** (or leave empty) for fast-fail.
- [ ] **Bootstrap the main worktree's config** from its `.example` files — automate it in `preSetup` (gated on `isMainWorktree`) so a fresh clone's first `workspace setup` works; siblings inherit from it.
- [ ] **Install `@paleo/workspace`** (Node consumers).
- [ ] **Write `workspace.mjs`** from the asset — adapt the `ADAPT` points, then strip the scaffolding.
- [ ] **Write `dev-server.mjs`** from the asset — same approach.
- [ ] **Add the `workspace` and `dev` npm scripts** (don't reuse the app's dev name).
- [ ] **Set `devLimit`** (default `5`).
- [ ] **Update `.gitignore`** for your shared and per-worktree directories.
- [ ] **Wire agents** — a search-ignore line, a workspaces section pointing at `workspace --guide`, the conventions, and the project-specific facts.
