# Implementing Worktree-Based Concurrent Local Environments

Blueprint for a **workspace** system — multiple git-worktree dev environments side by side. Requires git. The templates are Node.js, but the approach fits any runtime.

**Node consumers** install `@paleo/workspace` and write thin wrappers — `workspace.mjs`, plus `dev-server.mjs` when the project has a dev server — that build a config object and call `runWorkspace(config)` / `runDevServer(config)`. The package owns the kernel (workspace and dev-server registries, port allocation, branch lifecycle, process control, log polling, CLI). You supply project callbacks (`finalizeWorkspace`, `formatSummary`, optional `purgeInfrastructure`) plus a `gitignoredFiles` list.

**Non-Node consumers** reimplement the system from this design; the concept sections are self-contained. A project driven by an OpenClaw bot must also meet [the bot contract](#the-bot-contract).

The `assets/` scripts ([workspace.mjs](../assets/workspace.mjs), [dev-server.mjs](../assets/dev-server.mjs)) are annotated references. Each field carries an `ADAPT` comment. Copy a script, fill in the `ADAPT` points, then **strip the scaffolding comments** — keep only the rare comment explaining a non-obvious project choice. Aim for lean wrappers.

**The operating surface is self-documented.** `workspace --guide` (rendered in the project's package manager) lists every command, flag, recovery path, and the directory layout, adapted to the config — a portless project's guide carries no port or dev-server section. Read it; don't restate it, and point agents at it (see [Agent Instructions](#agent-instructions)). Kernel internals (foreground self-exit, cross-worktree stop, orphan healing) are the package's concern — setup needs only the callback contracts below.

This document is the **setup tutorial**: the decisions you make, and how to wire the wrappers.

## Portless mode

A project with no dev server — or one whose servers need no port — installs the same system without the port scheme: no `ports` group in `workspace.mjs`, no `dev-server.mjs`, no `dev` npm script. `ctx.ports` is empty everywhere, nothing is allocated, and no config file is patched with a port.

Everything else stands: the worktree lifecycle (`setup`, `remove`, `--enter`), shared-directory symlinks, gitignored-file seeding, the idempotent detached finalize and its progress ticker, `list` / `status` / `wait`, and orphan healing (`prune`).

Reading this document in portless mode, skip [Contiguous port scheme](#contiguous-port-scheme), [Concurrent dev-server cap](#concurrent-dev-server-cap), [`dev-server.mjs`](#dev-servermjs), and the port-block paragraphs of [The workspace registry](#the-workspace-registry).

## Implementation Process

Apply in order. The per-project decisions live in the [checklist](#checklist); this section is the sequence and its guardrails.

1. **Require a clean working tree.** Run `git status` first. If it isn't clean, stop and ask the developer to commit or stash. Testing commits scaffolding and creates/removes worktrees and branches — safe and reviewable only from a clean baseline.
2. **Investigate.** Read this doc, then inspect the repo to answer every checklist item: current ports and config files, shared vs per-worktree gitignored directories, database provisioning, package manager, and the dev-server's ready / fatal log markers. Note what needs migrating (scattered ports, a config file not yet gitignored, a colliding dev-script name).
3. **Present findings and plan, then get approval.** Port scheme or portless mode, the shared / per-worktree split, config files to patch, database strategy, dev-server command (and any rename), migrations. **Change nothing until the developer agrees.**
4. **Implement.** Work the checklist: install the package, write the wrappers, add the npm scripts, migrate ports / config, update `.gitignore`, write the agent docs.
5. **Commit once, then test.** Make a **single commit** with all the scaffolding — a prerequisite for testing, not a wrap-up: `workspace setup -c <branch>` builds the linked worktree from the committed `HEAD`, so the scripts and `package.json` changes must be committed to exist there. Then exercise the CLI end to end (the command sequence is in `workspace --guide`): bootstrap the main worktree, create a throwaway workspace, start / stop dev servers if the project has any, `list` and `status`, remove the throwaway, then delete the test branch you created — your own artifact, the one case where deleting a branch is expected.
6. **Fix by amending.** When a test surfaces a problem, fix it, fold it into the same commit with `git commit --amend`, and re-test. Keep the whole effort as one commit.
7. **Never push.** Leave the final, amended commit for the developer to review and push.

## Core Concepts — the Decisions

### Shared vs per-worktree gitignored directories

For each gitignored directory, decide: **shared** across worktrees, or **isolated** per worktree?

- **Shared** directories are symlinked to the main worktree — things that should be the same everywhere: personal notes, task plans.
- **Per-worktree** directories are created fresh in each worktree — things that must differ: databases, caches, logs, Docker volumes.

| Directory      | Kind               | Contents                      |
| -------------- | ------------------ | ----------------------------- |
| `.local/`      | Shared (symlinked) | Personal notes                |
| `.plans/`      | Shared (symlinked) | Task planning files           |
| `.local-wt/`   | Per-worktree       | Databases, caches, logs       |

Setup symlinks the shared directories and creates fresh per-worktree ones. A shared directory missing from the main worktree is created there first, so every symlink resolves. The names are customizable.

`runtimeDir` (`.local-wt/` above) stays per-worktree, but the kernel symlinks its `workspace-registry/` sub-directory to the main worktree's, so every worktree reads one registry.

The main worktree's `.plans` may itself be a symlink — into a clone of a team plans repository (see [plans-share-setup.md](plans-share-setup.md)); the symlink chain resolves on its own.

### Contiguous port scheme

Most projects scatter ports (server 3000, db 5432, frontend 5173). The system needs **all ports configurable and reorganized into a contiguous block** — one block per workspace. E.g. 3000 / 5432 / 5173 → 8100 / 8101 / 8102 in the main worktree, and 8110 / 8111 / 8112 in the next workspace. A one-time migration.

**Choose a base port that starts a range of at least 200 contiguous ports free on all common operating systems.** 8100 is a safe default (8100–8299). Steer a user away from 8000 — it collides with common HTTP alternates on some systems.

Docker services can remap the host port without touching the container's internal port.

### The workspace registry

A workspace is identified by its **name**: the basename of its worktree directory. `workspaces.json`, under the main worktree's `runtimeDir`, maps each name to its worktree path and state. Commands select a workspace by directory — a path or a bare basename — defaulting to the current worktree; the basename still resolves an orphan whose directory is gone.

**Limitation**: names must be unique. Registering a worktree whose basename already belongs to another path fails with an error naming the existing entry and its path. It surfaces only when worktrees live under different parent directories; the kernel dedupes siblings on its own.

With a `ports` group configured, an entry also carries a **block index** (`portIndex`): `0` for the main worktree — implicit, never stored — and 1.. for linked workspaces. The block starts at `firstPort = base + perWorkspace × index`. Setup takes the lowest free index, and a re-registered worktree keeps the one it had; when every index is taken, setup fails and points at `workspace remove`.

`perWorkspace` is both the block size and its spacing, so it caps the ports one workspace can declare. It defaults to `names.length` — the block is exactly the ports you declared — and is required with `compute`. Adding a port later shifts every workspace's block under the default; set `perWorkspace` explicitly to reserve headroom. The scheme spans `maxWorkspaces × perWorkspace` contiguous ports from `base` — e.g. 20 × 10 = 200, the range the base-port choice above must keep free.

Registry (under the main worktree's `runtimeDir`, e.g. `.local-wt/workspace-registry/workspaces.json`):

```json
{
  "workspaces": {
    "myproject-feat-214": {
      "worktree": "/abs/path/myproject-feat-214",
      "createdAt": "2026-01-01T00:00:00.000Z",
      "status": "ready",
      "portIndex": 1
    }
  }
}
```

### Concurrent dev-server cap

Host RAM is shared; parallel dev-servers can exhaust it. Pass `maxConcurrentDevServers` to `runDevServer` (omit for no limit). `5` is a sensible default — bump it for a light stack, lower it for a heavy one. A second registry, `dev-servers.json`, tracks live servers; at the cap, `dev` / `dev up` aborts and lists the active servers (re-run with `--evict` to stop the oldest and proceed).

### Gitignored files: **all** of them

Config files carrying ports (`.env`, `docker-compose.yml`, …) **must be gitignored**: worktrees share one git history, so a tracked config would be identical everywhere, defeating per-worktree ports.

`gitignoredFiles` seeds a gitignored file into each new worktree, then patches it per workspace. It is **not only for port-bearing files** — it is for **every gitignored file a worktree needs to function**. Each entry declares where its initial content comes from via `source.kind`:

- `{ kind: "mainWorktree" }` — copy the file at the same path from the main worktree. The common case: the developer's customized config flows into every sibling.
- `{ kind: "committed", path }` — copy a committed template (e.g. an `.example`) from the new worktree's own checkout, so it tracks the branch.
- `{ kind: "content", content }` — an inline string, or a sync/async function returning one.

`patch(content, { name, ports, mainWorktree, currentWorktree })` rewrites the content per workspace; **omit it to copy verbatim**:

- **Port-bearing** files patch the workspace's ports in: use `helpers.patchEnvFile` for `KEY=VALUE` files, and `helpers.extractHost` to preserve a non-localhost host (a main-worktree `API_URL=http://1.2.3.4:8001` stays `http://1.2.3.4:<newPort>` rather than collapsing to localhost).
- **Verbatim** files need no `patch`. These are the easy ones to forget, and the usual cause of a half-broken linked worktree: editor settings (`.vscode/settings.json`), a secondary `.env`, a private-registry token (`.npmrc`), a package's own env file, etc. **List every one** — a missing entry means the linked worktree silently lacks that file.
- Set `optional: true` for a file that may legitimately be absent at its source; it then warns and skips instead of aborting.

**Two-stage flow** (the `mainWorktree` source). (1) Once per repo, the main worktree's actual config is created from its `.example` and customized. (2) For every sibling, setup copies the main worktree's config and patches it — so main-worktree customizations (a public dev IP, secrets, feature flags) flow in for free. Trade-off: mistakes in the main config propagate too; keep it clean. A consumer who prefers example-derived configs uses a `committed` source (`{ kind: "committed", path: "...example" }`), usually behind a developer-local toggle so the choice stays per-developer.

**Automate stage 1 with `preSetup`** (see the [field contract](#workspacemjs)). Done by hand, stage 1 is the step a fresh clone has never run — so its first `workspace setup` aborts with `config source … not found` the moment a `mainWorktree`-sourced config is missing. The `preSetup` hook runs before `gitignoredFiles` are copied: on `isMainWorktree`, seed each gitignored config from its committed `.example` when absent. A fresh clone then sets up with zero manual steps, and siblings still inherit the customized main config through `gitignoredFiles`.

## Writing the Wrappers

The assets annotate every field; read them as you fill in the `ADAPT` points. This section is the contract those annotations assume. A portless project writes `workspace.mjs` alone.

### `workspace.mjs`

Builds a `WorkspaceConfig` and calls `runWorkspace`. Key fields:

- `workspaceScript` — absolute path; leave the `import.meta.url` line as-is (the package re-spawns the script for the detached finalize phase).
- `devServerScript` — absolute path to `dev-server.mjs`, so removal can shell out to it. Omit it when the project has no dev-server script.
- `ports` — optional group: `base` (first port of the main worktree's block), `maxWorkspaces` (main included, required), `perWorkspace` (defaults to `names.length`; required with `compute`), and exactly one of `names` (consecutive ports from `firstPort`) or `compute({ index, firstPort })` (full control; computed ports must stay within the block). Omit the whole group for [portless mode](#portless-mode). See [The workspace registry](#the-workspace-registry).
- `sharedDirs` (symlinked from main), `runtimeDir` (per-worktree; holds logs and the registry).
- `gitignoredFiles: Array<{ path, source, patch?, optional? }>` — one entry per gitignored file (see above). `source` (required) is `{ kind: "mainWorktree" }`, `{ kind: "committed", path }`, or `{ kind: "content", content }`. `patch(content, { name, ports, mainWorktree, currentWorktree })` rewrites per workspace; omit it to copy verbatim.
- `preSetup({ isMainWorktree, currentWorktree, mainWorktree, force, log })` — optional; runs **before** `gitignoredFiles` are copied. Bootstrap source files the kernel will look for — typically seed the main worktree's gitignored config from its committed `.example` so a fresh clone's first `workspace setup` works with no manual step. **MUST be idempotent**; on a linked-worktree setup it MUST NOT mutate the main worktree, so gate the bootstrap on `isMainWorktree` (`force` mirrors `--force` for re-seeding). Omit it when every `gitignoredFiles` entry uses a `committed` or `content` source (nothing to bootstrap).
- `finalizeWorkspace(ctx)` — the detached background step: infrastructure startup, DB readiness wait, install / build, migrations, seed. `ctx` carries `name`, `ports`, `branch`, `currentWorktree`, `mainWorktree`, `isMainWorktree`, `force`, and `progress(label)`. **MUST be idempotent** — `workspace setup` is the documented retry path and re-runs it; idempotency also covers a name reused after an orphan (force-remove the stale container named after the workspace before `up`). **Run `npm install` first**, so any later failure still leaves usable `node_modules/` for the retry to import `@paleo/workspace`. May `return { purgeData }` — an opaque blob persisted on the registry entry and handed to `purgeInfrastructure`; use it **only** for teardown identifiers you can't re-derive at purge time (deterministic container / volume names come from `name` + paths, so they don't go here).
- `purgeInfrastructure(ctx)` — optional destructive teardown (typically `docker compose down -v`). Runs on `workspace remove`, `prune`, and orphan removal. **MUST be idempotent and cwd-independent**: `ctx.worktree` may be gone (orphan), so branch on its presence and tear down *by name* in that case — derive names from `ctx.name` / `ctx.worktree` / `ctx.mainWorktree`, and read `ctx.purgeData` for non-derivable ids. Swallow errors.
- `formatSummary(ctx)` — returns the post-setup string. Don't list dev-server URLs; the dev-server isn't running yet at this point.

### `dev-server.mjs`

Builds a `DevServerConfig` and calls `runDevServer`. `servers: ServerDescriptor[]` — one entry per server, conceptually one dev server. Discriminated on `kind`:

- `kind: "spawn"` — `{ name, exec, port?, detectReady, detectError? }`. The runner spawns the process, logs to `<runtimeDir>/logs/<name>.log`, polls the log for readiness, and tracks the PID. Read `port` from your config with `helpers.readPortFromEnvFile(file, varName)` / `helpers.readPortFromJsonFile(file, jsonPath)`. Omit `port` for a process that listens on nothing; conflict detection, port sweeping and the summary URL then skip that server. `detectError` (optional) fails fast on a known fatal log pattern.
- `kind: "callback"` — `{ name, start(ctx), stop(ctx) }`. You own the lifecycle; declare infrastructure (Docker, DB) here, typically first. Servers start in array order, stop in reverse.

`kind: "callback"` rules (not type-enforced — read carefully):

- `start(ctx)` resolves only once the resource is ready (no log polling on the runner's side).
- Let a failing command throw (run with `stdio: "inherit"`, or print `err.stderr` on `"pipe"`). Never swallow it — a false success starts later servers against a dead dependency and hides the root cause.
- Thread `ctx.cwd` into every child process and resolve every path against it. Never call bare `execSync("docker compose …")` — it picks up `process.cwd()` and breaks cross-worktree stop.
- Resolve everything inside the callback, not at module load.

Also: `maxConcurrentDevServers` (the cap), optional `formatSummary({ workspace, servers })` — `workspace` being `{ name, worktree, main? }`.

### Database provisioning

Each worktree needs its own database; how is project-specific. The setup must end with a working DB.

- **File-based (SQLite, etc.):** copy the data directory from the main worktree — the simplest case.
- **Docker (PostgreSQL, MySQL, etc.):** copy `docker-compose.yml` (as a `gitignoredFiles` entry, patching the host port and a workspace-scoped `container_name` so containers don't collide), `docker compose up -d`, wait for readiness, run migrations, run the seed.

**Postgres readiness gotcha:** poll `pg_isready -h 127.0.0.1` (a TCP check), not a plain probe. On a fresh volume, Postgres first runs a throwaway Unix-socket-only server for `initdb` that answers a socket-side `pg_isready` too early; gating on TCP — which that init server doesn't listen on — stops the next step from connecting to it and losing the connection on handoff.

### npm scripts to add

```json
{ "workspace": "node scripts/workspace/workspace.mjs", "dev": "node scripts/workspace/dev-server.mjs" }
```

The single `dev` script carries every subcommand. Don't name it after the app's own dev command — a spawn server running `npm run dev` would recurse; use a distinct name (e.g. `dev:app`). A project without a dev server adds the `workspace` script alone.

## Agent Instructions

The system only works if agents know about it. The CLI self-documents via `workspace --guide`, so wire just two things: a pointer to that command, and the facts the CLI can't know.

### Main instruction file (`AGENTS.md` / `CLAUDE.md`)

- **Conventions that affect workspaces** — branch naming and commit message conventions, because the agent creates branches:

  ```markdown
  Branch naming convention: `<type>/<ticket-id>` (e.g., `feat/123`).
  Commit message convention: conventional commits, e.g., `feat: [#123] add new feature`.
  ```

- **A workspaces section** pointing at the guide. Take the definition from the first paragraph of `workspace --guide`, which already matches the project's config — it names ports, a database and a dev server on a port-based project, and the shared directories and seeded config files in [portless mode](#portless-mode). Add the repo-specific facts the CLI can't know, such as a portless project having no `dev` script:

  ```markdown
  ## Workspaces

  A **workspace** is a git worktree (with its branch) plus its own dev setup: dedicated ports, config files, a database, and a dev server you can bring up or down. Workspaces are isolated, so you can run several branches in parallel.

  Run `npm run workspace -- --guide` for the full procedures.
  ```

  Keep it to those two parts. Restating the CLI — `setup`, `remove`, `list` — duplicates `--guide` and goes stale when the commands change.

- **A search-ignore line** so agents skip gitignored runtime dirs. List `runtimeDir` (e.g. `.local-wt`), and `.local` only if your repo uses it. Extend an existing line rather than duplicate:

  ```markdown
  Always ignore the `.local-wt`, `.plans` directories when searching the codebase.
  ```

On a bot-driven project, `DEVELOPMENT.md` carries the same workspaces section: the bot reads that file to learn how to create a worktree or a branch. Same two parts, same limit — the definition and the pointer to `--guide`, never the command list.

### Project-specific facts the guide can't know

Record only repo-specific facts, in whatever entry point developers and agents already read (`README.md`, `AGENTS.md`, `DEVELOPMENT.md`):

1. **URLs to open after `dev` starts** (admin UI, auto-login), with the dynamic port.
2. **Any project quirk** — extra build steps, a non-obvious log path.

The release process is not one of them: a multi-step procedure followed occasionally belongs in `docs/`, read on demand — see [Procedures belong in `docs/`](docmap-bootstrapping.md#procedures-belong-in-docs-not-in-an-entry-point).

The port layout is not one of them either: the block table, what raising `perWorkspace` costs elsewhere in the repo, which config file each port reaches. That reference material belongs in `docs/`, with nothing left behind in the entry points. Point at the document from the `ports` group in `workspace.mjs`. Entry points keep only what a reader needs every session: the ports are printed at startup, read them from the log.

## The bot contract

An OpenClaw bot creates every worktree through the workspace system; its playbook offers no hand-made fallback, so a project it drives must have the system installed. `@paleo/workspace` satisfies the contract below as shipped. A reimplementation must provide the same behavior, whatever its language and runner: the playbook reads the invocation from `DEVELOPMENT.md`, so the command's name and prefix are free while its behavior is fixed.

| Requirement | Why the bot needs it |
| --- | --- |
| A `--guide` flag printing the full operating procedures | The playbook points the bot at the guide instead of restating the commands. |
| A command listing **registered** workspaces, runnable from any worktree | The bot checks whether the ticket already has a workspace before creating one. |
| `setup` on an existing branch **and** on a new one | It handles three entry cases: no branch, branch only, branch plus worktree. |
| `setup` blocking in the foreground until a terminal state, with an opt-in background mode | The bot runs it in the foreground and reports the state it returns. |
| The states named `running`, `ready` and `failed` | They go verbatim into the bot's `[WORKSPACE]` banner. |
| `remove` performing the whole teardown in one command: dev server, infrastructure, registry entry, worktree directory | The bot delegates a cleanup request as a single step. |
| `setup` seeding the shared-directory symlinks (`.plans`) and the gitignored config files | The bot runs no post-create step by hand. |

A project with a dev server adds its start, stop and status commands, and the URL to report to the user.

## Checklist

Items marked *(ports)* drop out without a port scheme, items marked *(dev server)* without a dev server — see [portless mode](#portless-mode).

- [ ] **Make all dev ports configurable and contiguous.** *(ports)* Prerequisite.
- [ ] **Design the port scheme.** *(ports)* Ports per environment? `perWorkspace` defaults to `names.length`; set it explicitly to reserve headroom. Base port 8100 unless you have a reason. Document the resulting layout in `docs/`.
- [ ] **Identify your gitignored files.** Every gitignored file a worktree needs — port-bearing *and* verbatim (editor settings, secondary `.env`, private-registry tokens). Do they have `.example` versions?
- [ ] **Classify gitignored directories.** Shared (symlinked) vs per-worktree.
- [ ] **Decide database provisioning.** File copy (SQLite) or Docker + migrate + seed.
- [ ] **Decide the dev-server ready marker** and **fatal markers** (or leave empty) for fast-fail. *(dev server)*
- [ ] **Bootstrap the main worktree's config** from its `.example` files — automate it in `preSetup` (gated on `isMainWorktree`) so a fresh clone's first `workspace setup` works; siblings inherit from it.
- [ ] **Install `@paleo/workspace`** (Node consumers).
- [ ] **Write `workspace.mjs`** from the asset — adapt the `ADAPT` points, then strip the scaffolding.
- [ ] **Write `dev-server.mjs`** from the asset — same approach. *(dev server)*
- [ ] **Add the `workspace` npm script**, and the `dev` one *(dev server)* (don't reuse the app's dev name).
- [ ] **Set `maxConcurrentDevServers`** (default `5`). *(dev server)*
- [ ] **Update `.gitignore`** for your shared and per-worktree directories.
- [ ] **Wire agents** — a search-ignore line, a workspaces section pointing at `workspace --guide` (in `DEVELOPMENT.md` too on a bot-driven project), the conventions, and the project-specific facts.
- [ ] **Check [the bot contract](#the-bot-contract)** on a bot-driven project. Automatic with `@paleo/workspace`; a matter of verification in a reimplementation.
- [ ] **Verify the whole lifecycle** on a throwaway branch: `workspace setup -c <branch>`, then check the linked worktree's gitignored files carry its own ports, start its dev server *(dev server)*, and finish with `workspace remove`. A wrapper that merely loads proves nothing.
