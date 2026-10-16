# Implementing Worktree-Based Concurrent Local Environments

Blueprint for a **workspace** system — multiple git-worktree dev environments side by side. Requires git. The templates are Node.js, but the approach fits any runtime.

Workspace can be installed on its own. Add the workspace instructions below; AlignFirst skills, protocols, and Docmap are separate choices.

**Node consumers** install `@alignfirst/workspace` and write thin wrappers — `workspace.mjs`, plus `dev-server.mjs` when the project has a dev server — that build a config object and call `runWorkspace(config)` / `runDevServer(config)`. The package owns the kernel (workspace and dev-server registries, port allocation in the dev-server, branch lifecycle, process control, log polling, CLI). In `workspace.mjs`, you supply project callbacks (`finalizeWorkspace`, `formatSummary`, optional `purgeInfrastructure`) plus a `gitignoredFiles` list. In `dev-server.mjs`, you declare the port range, the files that carry ports, the infrastructure `setup` and the servers.

**Non-Node consumers** reimplement the system from this design; the concept sections are self-contained. A project managed by an assistant must also meet [the AlignDev contract](#the-aligndev-contract).

The `assets/` scripts ([workspace.mjs](../assets/workspace.mjs), [dev-server.mjs](../assets/dev-server.mjs)) are annotated references. Each field carries an `ADAPT` comment. Copy a script, fill in the `ADAPT` points, then **strip the scaffolding comments** — keep only the rare comment explaining a non-obvious project choice. Aim for lean wrappers.

**The operating surface is self-documented.** `workspace --guide` (rendered in the project's package manager) lists every command, flag, recovery path, and the directory layout, adapted to the config — a project without a dev server gets a guide without the dev-server section. Read it; don't restate it, and point agents at it (see [Agent Instructions](#agent-instructions)). Kernel internals (foreground self-exit, cross-worktree stop, orphan healing) are the package's concern — setup needs only the callback contracts below.

This document is the **setup tutorial**: the decisions you make, and how to wire the wrappers.

## Portless mode

A project whose servers need no port installs the same system without ports: no `ports` group in `dev-server.mjs`. A project with no dev server has no `dev-server.mjs` at all, and no `dev` npm script. `ctx.ports` is empty everywhere, nothing is allocated, and no file is patched with a port.

Everything else stands: the worktree lifecycle (`setup`, `remove`, `--enter`), shared-directory symlinks, gitignored-file seeding, the idempotent detached finalize and its progress ticker, `list` / `status` / `wait`, and orphan healing (`prune`).

Reading this document in portless mode, skip [Port range](#port-range). Without a dev server, also skip [Concurrent dev-server cap](#concurrent-dev-server-cap) and [`dev-server.mjs`](#dev-servermjs).

## Implementation Process

Apply in order. The per-project decisions live in the [checklist](#checklist); this section is the sequence and its guardrails.

1. **Require a clean working tree.** Run `git status` first. If it isn't clean, stop and ask the developer to commit or stash. Testing commits scaffolding and creates/removes worktrees and branches — safe and reviewable only from a clean baseline.
2. **Investigate.** Read this doc, then inspect the repo to answer every checklist item: current ports and config files, shared vs per-worktree gitignored directories, database provisioning, package manager, and the dev-server's ready / fatal log markers. Note what needs migrating (scattered ports, a tracked config file with hard-coded ports, a colliding dev-script name).
3. **Present findings and plan, then get approval.** Port range or portless mode, the shared / per-worktree split, config files to patch, database strategy, dev-server command (and any rename), migrations. **Change nothing until the developer agrees.**
4. **Implement.** Work the checklist: install the package, write the wrappers, add the npm scripts, migrate ports / config, update `.gitignore`, write the agent docs.
5. **Commit once, then test.** Make a **single commit** with all the scaffolding — a prerequisite for testing, not a wrap-up: `workspace setup -c <branch>` builds the linked worktree from the committed `HEAD`, so the scripts and `package.json` changes must be committed to exist there. Then exercise the CLI end to end (the command sequence is in `workspace --guide`): bootstrap the main worktree, create a throwaway workspace, start / stop dev servers if the project has any, `list` and `status`, remove the throwaway, then delete the test branch you created — your own artifact, the one case where deleting a branch is expected.
6. **Fix by amending.** When a test surfaces a problem, fix it, fold it into the same commit with `git commit --amend`, and re-test. Keep the whole effort as one commit.
7. **Never push.** Leave the final, amended commit for the developer to review and push.

## Core Concepts — the Decisions

### Shared vs per-worktree gitignored directories

For each gitignored directory, decide: **shared** across worktrees, or **isolated** per worktree?

- **Shared** directories are symlinked to the main worktree — things that should be the same everywhere: personal notes, work files.
- **Per-worktree** directories are created fresh in each worktree — things that must differ: databases, caches, logs, Docker volumes.

| Directory      | Kind               | Contents                      |
| -------------- | ------------------ | ----------------------------- |
| `.local/`      | Shared (symlinked) | Personal notes                |
| `.plans/`      | Shared (symlinked) | Task planning files           |
| `.local-wt/`   | Per-worktree       | Databases, caches, logs       |

Setup symlinks the shared directories and creates fresh per-worktree ones. A shared directory missing from the main worktree is created there first, so every symlink resolves. The names are customizable.

Suggest `.local/` by default, even when the repo has no such directory yet: a gitignored shared directory for personal notes and files, declared in `sharedDirs`.

`runtimeDir` (`.local-wt/` above) stays per-worktree, but the kernel symlinks its `workspace-registry/` sub-directory to the main worktree's, so every worktree reads one registry.

The main worktree's `.plans` may itself be a symlink — into a clone of the work-files repository (see [plans-setup.md](plans-setup.md)); the symlink chain resolves on its own.

### Port range

Most projects scatter ports (server 3000, db 5432, frontend 5173). The system needs **all dev ports configurable**: each workspace runs its servers on its own ports.

The project claims one range, `first`–`last` in the `ports` group of `dev-server.mjs`, and declares its ports in `declare`. Each workspace gets one port per declared name at its first `dev setup`, stored on its registry entry:

- Allocation takes the lowest port of the range that is not excluded (`exclude`), not on the browsers' bad-port list (6000, 6665–6669, 10080…), not held by another workspace, and not busy on the machine.
- A port stays fixed afterwards. Every start reconciles the names with the stored ports: a new name gets a port, an undeclared name frees its port, and a port the config no longer allows is allocated again.
- `dev setup --reset-ports` allocates all of the workspace's ports again, for instance when an outside service took one.
- `workspace remove` frees the workspace's ports. An exhausted range is an error that points at `workspace remove`.

**Size the range** as names × expected concurrent workspaces. 8100–8199 is a safe default. Steer a user away from 8000 — it collides with common HTTP alternates on some systems.

**Allocated ports are unpredictable.** An entry of `declare` is a name, or `{ name, range?, mainWorktree? }` to control where its port lands:

- `mainWorktree` pins the main worktree's port: the main worktree always gets it, and no other workspace does. Use it when something outside the repository depends on one fixed port, such as a bookmark.
- `range` dedicates a block of the range to the name: the name gets ports only there, and the other names never do. Use it when something outside the repository enumerates a port for every workspace, such as an OAuth callback URL in a provider's allowlist. Size the block for the expected concurrent workspaces, and list it in the allowlist. A pin of that name lies inside the block.

Docker services can remap the host port without touching the container's internal port.

### The workspace registry

A workspace is identified by its **name**: the basename of its worktree directory. `workspaces.json`, under the main worktree's `runtimeDir`, maps each name to its worktree path and state. Commands select a workspace by directory — a path or a bare basename — defaulting to the current worktree; the basename still resolves an orphan whose directory is gone.

**Limitation**: names must be unique. Registering a worktree whose basename already belongs to another path fails with an error naming the existing entry and its path. It surfaces only when worktrees live under different parent directories; the kernel dedupes siblings on its own.

Registry (under the main worktree's `runtimeDir`, e.g. `.local-wt/workspace-registry/workspaces.json`):

```json
{
  "version": 2,
  "workspaces": {
    "myproject-feat-214": {
      "worktree": "/home/me/projects/myproject-feat-214",
      "createdAt": "2026-01-01T00:00:00.000Z",
      "status": "ready",
      "ports": { "server": 8103, "frontend": 8104, "db": 8105 },
      "devSetupAt": "2026-01-01T00:05:00.000Z"
    }
  }
}
```

`ports` and `devSetupAt` arrive with the first `dev setup`.

### Setup modes

A workspace for a code review needs no ports and no infrastructure. `workspace setup` therefore stops after the worktree, the symlinks, the `gitignoredFiles` and `finalizeWorkspace` (install, build). The workspace is then `ready`.

`dev setup` brings the rest: the ports, the run files, and the infrastructure at its first run. It runs explicitly, or implicitly before every start.

`workspace setup --full` does both at once. A dev failure there leaves the workspace `ready`: the command reports the failure and exits 1, and the next `dev setup` or start retries.

### Concurrent dev-server cap

Host RAM is shared; parallel dev-servers can exhaust it. Pass `maxConcurrentDevServers` to `runDevServer` (omit for no limit). `5` is a sensible default — bump it for a light stack, lower it for a heavy one. A second registry, `dev-servers.json`, tracks live servers; at the cap, `dev` / `dev up` aborts and lists the active servers (re-run with `--evict` to stop the oldest and proceed).

### Gitignored files: two lists

Per-worktree values (ports, workspace-scoped names) **must live in gitignored files**: worktrees share one git history, so a tracked file is identical everywhere. A tracked file may reference them through interpolation, like a committed `docker-compose.yml` reading its ports from the gitignored `.env`.

Every gitignored file a worktree needs to function goes in one of two lists:

- **`runFiles`** in `dev-server.mjs` — a file carrying ports, or a file needed only to run. `dev setup` writes them, and runs before every start.
- **`gitignoredFiles`** in `workspace.mjs` — another file, when install, build or tests need it. `workspace setup` writes them.

One path belongs to one list only. The kernel cannot check it, because each list lives in its own config file. A file mixing secrets and ports is a run file. When a worktree needs its other values without `dev setup`, split the ports into their own file, such as `.env.ports`.

Both lists take the same entries. Each declares where its initial content comes from via `source.kind`:

- `{ kind: "mainWorktree", fallback? }` — use the file at the same path in the main worktree when it exists. Otherwise, use the optional committed fallback from the current worktree's branch.
- `{ kind: "committed", path }` — copy a committed template (e.g. an `.example`) from the new worktree's own checkout, so it tracks the branch.
- `{ kind: "content", content }` — an inline string, or a sync/async function receiving the patch context and returning a string.

Functional content and `patch(content, ctx)` receive the same context: `{ name, mainWorktree, currentWorktree, isMainWorktree }`, plus `ports` for a run file. The boolean is `true` in the main worktree. When the file already exists, the kernel re-applies `patch` to its current content and rewrites it only when the result differs — the port keys follow the allocation, the rest of the file stays as the developer left it. It prints the rewritten files in one `Updated <paths>` line. A `patch` **MUST be idempotent** and touch only the keys it owns; `helpers.patchEnvFile` is. The kernel fails on a `patch` that is not idempotent. **Omit `patch` to copy the selected content verbatim**:

- **Run files** patch the workspace's ports in: use `helpers.patchEnvFile` for `KEY=VALUE` files. A deleted run file is created again from its source at the next `dev setup`.
- **Verbatim** files need no `patch`; an existing one is left alone unless `workspace setup --force` reseeds it. These are the easy ones to forget, and the usual cause of a half-broken linked worktree: editor settings (`.vscode/settings.json`), a secondary `.env`, a private-registry token (`.npmrc`), a package's own env file, etc. **List every one** — a missing entry means the linked worktree silently lacks that file.
- Set `optional: true` for a file that may legitimately be absent at its source; it then warns and skips instead of aborting.

**Main-worktree fallback flow.** Declare `{ kind: "mainWorktree", fallback: ".env.example" }` when a committed template exists. Resolution first checks the entry path in the main worktree. If that file is absent, it resolves `fallback` from the current worktree's branch. Without a fallback, a missing main file retains the standard required or optional source behavior. In the main worktree, a `mainWorktree` source is the file itself, so a run file there gets only its ports rewritten.

The fallback supports fresh main and linked setup. Its content still passes through `patch` before the target is written. Once the main file exists, linked workspaces inherit that customized content instead. A linked setup may read its branch's fallback without creating the missing main-worktree file as a side effect.

## Writing the Wrappers

The assets annotate every field; read them as you fill in the `ADAPT` points. This section is the contract those annotations assume. A project without a dev server writes `workspace.mjs` alone.

### `workspace.mjs`

Builds a `WorkspaceConfig` and calls `runWorkspace`. Key fields:

- `workspaceScript` — absolute path; leave the `import.meta.url` line as-is (the package re-spawns the script for the detached finalize phase).
- `devServerScript` — absolute path to `dev-server.mjs`, so removal can shell out to its `down` and `setup --full` to its `setup`. Omit it when the project has no dev-server script.
- `sharedDirs` (symlinked from main), `runtimeDir` (per-worktree; holds logs and the registry).
- `gitignoredFiles: Array<{ path, source, patch?, optional? }>` — the files install, build or tests need ([Gitignored files](#gitignored-files-two-lists)). Functional `content(ctx)` and `patch(content, ctx)` receive `{ name, mainWorktree, currentWorktree, isMainWorktree }`; omit `patch` to copy verbatim.
- `preSetup({ name, isMainWorktree, currentWorktree, mainWorktree, force, log })` — optional; runs **before** `gitignoredFiles` are copied. Use it for work outside file-source resolution, such as checking the work-files link with `npx alignfirst plans check`, creating directories, or configuring git hooks. **MUST be idempotent**; on a linked-worktree setup it MUST NOT mutate the main worktree. Omit the hook only when it has no remaining work.
- `finalizeWorkspace(ctx)` — the detached background step: install and build. It returns nothing; infrastructure belongs in `setup` of `dev-server.mjs`. `ctx` carries `name`, `branch`, `currentWorktree`, `mainWorktree`, `isMainWorktree`, `force`, and `progress(label)`. **MUST be idempotent** — `workspace setup` is the documented retry path and re-runs it. **Run `npm install` first**, so any later failure still leaves usable `node_modules/` for the retry to import `@alignfirst/workspace`.
- `purgeInfrastructure(ctx)` — optional destructive teardown (typically `docker compose down -v`). Runs on `workspace remove`, `prune`, and orphan removal, whether or not `dev setup` ever succeeded. **MUST be idempotent and cwd-independent**: `ctx.worktree` may be gone (orphan), so tear down *by name* ([Teardown by name](#teardown-by-name)). `ctx.purgeData` is legacy: only a workspace provisioned by an older `finalizeWorkspace` carries one. Swallow errors.
- `formatSummary(ctx)` — returns the post-setup string. Don't list dev-server URLs; the dev-server isn't running yet at this point.

### `dev-server.mjs`

Builds a `DevServerConfig` and calls `runDevServer`. Key fields:

- `ports` — optional: `{ first, last, exclude?, declare }`, each entry of `declare` a name or `{ name, range?, mainWorktree? }` ([Port range](#port-range)). Omit it for a portless dev-server.
- `runFiles: Array<{ path, source, patch?, optional? }>` — the files that carry ports, or are needed only to run ([Gitignored files](#gitignored-files-two-lists)). The context of `content(ctx)` and `patch(content, ctx)` adds `ports`, the workspace's ports by name.
- `setup(ctx)` — optional; the workspace's infrastructure: start the database, wait for it, migrate, seed. Runs at the first `dev setup`, and again with `dev setup --force`. **MUST be idempotent**. Names every resource it creates after the workspace (`ctx.name`), so `purgeInfrastructure` finds it by name. `ctx` carries `name`, `ports`, `currentWorktree`, `mainWorktree`, `isMainWorktree`, `force` and `log`. A failure aborts the start; the next `dev setup` or start runs it again.
- `servers: ServerDescriptor[]` — one entry per server, conceptually one dev server. Described below.
- `maxConcurrentDevServers` (the cap), optional `formatSummary({ workspace, servers })` — `workspace` being `{ name, worktree, main? }`.

A server is discriminated on `kind`:

- `kind: "spawn"` — `{ name, exec, port?, detectReady, detectError? }`. The runner spawns the process, logs to `<runtimeDir>/logs/<name>.log`, polls the log for readiness, and tracks the PID. `port` is a name from `ports.declare`, resolved to the workspace's port, or a fixed number. Omit `port` for a process that listens on nothing; conflict detection, port sweeping and the summary URL then skip that server. `detectError` (optional) fails fast on a known fatal log pattern.
- `kind: "callback"` — `{ name, start(ctx), stop(ctx) }`. You own the lifecycle of a resource that runs with the dev server, such as a Docker stack, typically first. Servers start in array order, stop in reverse. `ctx` carries `cwd` and `ports`, the ports of the worktree in `cwd`.

`kind: "callback"` rules (not type-enforced — read carefully):

- `start(ctx)` resolves only once the resource is ready (no log polling on the runner's side).
- Let a failing command throw (run with `stdio: "inherit"`, or print `err.stderr` on `"pipe"`). Never swallow it — a false success starts later servers against a dead dependency and hides the root cause.
- Thread `ctx.cwd` into every child process and resolve every path against it. Never call bare `execSync("docker compose …")` — it picks up `process.cwd()` and breaks cross-worktree stop.
- Resolve everything inside the callback, not at module load.
- A callback server gets no port, no PID and no log file, so `formatSummary` is the only place it can surface. Give it a row of the same shape as the spawn servers — what reaches it, then how its logs are read — so one column means one thing on every row. For a database: the connection string without the password, the container name (`<project>-<service>-1`, or the seeded `container_name`), and the command that tails the container logs.

**A moved port reaches the infrastructure** only when a callback `start` recreates it from the updated run files, as `docker compose up -d` does. `setup` runs once, so it never picks up a port that moved later.

### Teardown by name

No teardown state is stored. `purgeInfrastructure` finds every resource by the workspace name: the compose project, the database, an external resource named or tagged after the workspace. A partial `setup` is therefore torn down like a complete one.

A resource the provider identifies only by a random id is recorded in a file named after the workspace, under the main worktree: for example `join(ctx.mainWorktree, ".local-wt", "tunnels", ctx.name)`. `setup` writes it as soon as the resource exists. Teardown reads it, closes the resource and deletes it. Both build the path from `ctx.mainWorktree`, never from the current worktree: a linked worktree's runtime directory goes away with it.

### Database provisioning

Each worktree needs its own database; how is project-specific. Provision it in the dev-server's `setup`, so a workspace gets its database at its first `dev setup`.

- **File-based (SQLite, etc.):** copy the data directory from the main worktree — the simplest case.
- **Docker (PostgreSQL, MySQL, etc.):** give each worktree its own ports through the compose file ([Docker Compose](#docker-compose)), `docker compose up -d`, wait for readiness, run migrations, run the seed.

**Postgres readiness gotcha:** poll `pg_isready -h 127.0.0.1` (a TCP check), not a plain probe. On a fresh volume, Postgres first runs a throwaway Unix-socket-only server for `initdb` that answers a socket-side `pg_isready` too early; gating on TCP — which that init server doesn't listen on — stops the next step from connecting to it and losing the connection on handoff.

#### Docker Compose

The compose file reaches each worktree through one of two patterns. Follow the one the repo already uses. With no compose file yet, choose the committed pattern, the common layout in repositories.

- **Committed compose file.** `docker-compose.yml` is tracked and identical in every worktree. Each published port is a required variable: `"127.0.0.1:${DB_PORT:?run dev setup}:5432"`. The `.env` run file carries the values: add them to its patch, or generate the file with a `content` source when the project has no root `.env`. Compose reads `.env` from the project directory on its own. A tracked compose file with hard-coded ports moves to this pattern: interpolate each published port, and drop `container_name`.
- **Seeded compose file.** `docker-compose.yml` is gitignored and seeded from a committed `docker-compose.example.yml` by a `runFiles` entry. Its patch writes the host port, and a workspace-scoped `container_name` when the file declares one. With a `container_name`, make `setup` force-remove a leftover container of that name before `up`.

A required variable (`:?`) fails `up` when `.env` lacks it. A default (`:-8102`) would fall back silently to the main worktree's ports. Keep a default only when the repo already relies on one, such as a CI job running compose without `.env`.

**Isolation comes from the compose project name**, which Compose derives from the worktree directory. Containers are `<project>-<service>-1`, volumes `<project>_<volume>`. Keep it that way: no top-level `name:` in the compose file, no `COMPOSE_PROJECT_NAME` in `.env`.

**The project name is normalized.** Compose lowercases the directory name, drops every character outside `[a-z0-9_-]`, and trims leading `-` and `_`. A workspace name keeps the branch's case (`myrepo-feat-ABC-123`), so derive the project with `helpers.composeProjectName(name)`. This holds in both patterns: `container_name` renames a container, never its volumes.

**Teardown needs no compose file.** `docker compose -p <project> down -v` removes the project's containers, volumes and network by label, from any directory. It also catches a volume that a branch added.

**Changing the layout** (seeded to committed, or back) affects every branch on the other side of the change. Moving to the committed pattern, Git overwrites the ignored compose file when a checkout, merge or rebase brings the tracked one. Update a worktree in this order: stop its dev server, update the branch, start the dev server.

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

  A **workspace** is a git worktree (with its branch) plus its own dev setup: dedicated ports, config files, infrastructure such as a database, and a dev server you can bring up or down. Ports and infrastructure arrive with the first `npm run dev` or `npm run dev -- setup`. Workspaces are isolated, so you can run several branches in parallel.

  Run `npm run workspace -- --guide` for the full procedures.
  ```

  Keep it to those two parts. Restating the CLI — `setup`, `remove`, `list` — duplicates `--guide` and goes stale when the commands change.

- **A search-ignore line** so agents skip gitignored runtime dirs. List every shared directory and `runtimeDir`. Extend an existing line rather than duplicate:

  ```markdown
  Always ignore the `.plans`, `.local` and `.local-wt` directories when searching the codebase.
  ```

  Skip this line when the instruction file runs `alignfirst context`; the command renders the
  exclusions.

On a project prepared for an assistant, `DEVELOPERS.md` carries the same workspaces section. The definition and the pointer to `--guide` are sufficient; do not copy the command list.

### Project-specific facts the guide can't know

Record only repo-specific facts, in whatever entry point developers and agents already read (`README.md`, `AGENTS.md`, `DEVELOPERS.md`):

1. **URLs to open after `dev` starts** (admin UI, auto-login), with the dynamic port.
2. **Any project quirk** — extra build steps, a non-obvious log path.

The release process is not one of them: a multi-step procedure followed occasionally belongs in `docs/`, read on demand — see [Procedures belong in `docs/`](docmap-bootstrapping.md#procedures-belong-in-docs-not-in-an-entry-point).

The allocated ports are not one of them either: each workspace gets its own, and `workspace list` and `status` show them.

## The AlignDev Contract

An assistant creates every worktree through the workspace system and has no manual fallback. `@alignfirst/workspace` gives it the CLI it relies on: `--guide`, `list`, the `setup` states, one-command `remove`. A reimplementation reproduces that surface as `workspace --guide` describes it. On top of the kernel, a managed project provides:

1. The workspaces section in `DEVELOPERS.md` ([Agent Instructions](#agent-instructions)).
2. Public URLs from the environment *(dev server)*, below.
3. A `dev up` summary printing the public URL *(dev server)*: `formatSummary` in `dev-server.mjs` reads it from the run file, so the assistant reports an address that works from the user's browser.
4. A README section on remote access, below.
5. A Node version declaration (`.nvmrc`, `.node-version` or `engines.node`) named in `DEVELOPERS.md`, so fnm selects the project runtime. Ask which version to declare when the repository has none.

### Public URLs

The assistant's dev servers are reached from the team's browsers. The run-file patches build every URL a browser or a third party resolves from the workspace's own port: the API base URL, the front URL, OAuth callbacks, CORS origins, allowed hosts. Server-to-server URLs stay on localhost.

The deployment's environment selects the host:

- **`REMOTE_DEV_DOMAIN` set (HTTPS gateway).** The dev-server gateway serves port `<port>` at `https://p<port>.<domain>` behind a login, so the public URL is `https://p<port>.<domain>`. An application that distinguishes them also gets the public protocol (`https`), the public port (`443`) and the trusted proxy (loopback). The servers keep listening on `localhost:<port>`; the gateway proxies to them.
- **`REMOTE_DEV_HOST` set (public IP).** No gateway: the browser reaches `http://<host>:<port>` directly, so the servers must listen on every interface.
- **Neither.** `http://localhost:<port>`.

Nothing is stored or run. Each worktree computes its URLs at each start, so the next start after the variable goes away returns to localhost. See `publicUrl` in [dev-server.mjs](../assets/dev-server.mjs).

### README section

`README.md` documents remote access next to the setup commands: exporting the variable before `dev` is enough. Gateway form:

````markdown
### Remote access

When the dev servers are reached through the HTTPS gateway, export the gateway's domain before starting them:

```sh
export REMOTE_DEV_DOMAIN=dev.example.org
npm run dev
```
````

Public-IP form: the same section with `export REMOTE_DEV_HOST=<public-ip>`, introduced by "When the dev servers are reached from other machines through the machine's public IP".

Pick the form from the deployment that will run the project: the gateway form when `REMOTE_DEV_DOMAIN` is set in the assistant's environment, the public-IP form when the deployment opens the dev-port range on its public IP. Ask the user when the deployment is unknown.

## Checklist

Items marked *(ports)* drop out without ports, items marked *(dev server)* without a dev server — see [portless mode](#portless-mode).

- [ ] **Make all dev ports configurable.** *(ports)* Prerequisite.
- [ ] **Claim the port range.** *(ports)* Size it as names × expected concurrent workspaces; 8100–8199 unless you have a reason. When `.alignfirst.json` exists, set its `portRange` to `first` and `last` of the `ports` group in `dev-server.mjs`: the dev-server compares them on every command and refuses a mismatch. Standalone workspace setup does not require this file. Pin the ports something outside the repository depends on with the `mainWorktree` of their `declare` entry. A dedicated `range` takes its share of the sizing and holds its entry's pin.
- [ ] **Identify your gitignored files and split them into the two lists.** Every gitignored file a worktree needs: the files carrying ports go in `runFiles`, the others in `gitignoredFiles` when install, build or tests need them — verbatim ones included (editor settings, secondary `.env`, private-registry tokens). Do they have `.example` versions?
- [ ] **Classify gitignored directories.** Shared (symlinked) vs per-worktree. Suggest a shared `.local/` by default.
- [ ] **Decide database provisioning** in the dev-server's `setup`. File copy (SQLite) or Docker + migrate + seed. With Docker, follow the repo's compose pattern, committed by default ([Docker Compose](#docker-compose)).
- [ ] **Decide the dev-server ready marker** and **fatal markers** (or leave empty) for fast-fail. *(dev server)*
- [ ] **Pair main-worktree sources with committed fallbacks.** Declare each existing `.example` template as `fallback` so fresh main and linked setup work while siblings still prefer customized main files.
- [ ] **Install `@alignfirst/workspace`** (Node consumers).
- [ ] **Write `workspace.mjs`** from the asset — adapt the `ADAPT` points, then strip the scaffolding.
- [ ] **Write `dev-server.mjs`** from the asset — same approach. *(dev server)*
- [ ] **Add the `workspace` npm script**, and the `dev` one *(dev server)* (don't reuse the app's dev name).
- [ ] **Set `maxConcurrentDevServers`** (default `5`). *(dev server)*
- [ ] **Give every callback server its own row in the `dev up` summary.** *(dev server)* The spawn servers get a URL, a PID and a log path for free; a database or a mock container gets none of the three. Print its connection string, its container name and the container-logs command, in the same column order as the spawn rows.
- [ ] **Update `.gitignore`** for your shared and per-worktree directories.
- [ ] **Wire agents** — a workspaces section pointing at `workspace --guide` (also in `DEVELOPERS.md` for a managed project), the conventions, and the project-specific facts. Add the search-ignore line unless the instruction file runs `alignfirst context`.
- [ ] **Meet [the AlignDev contract](#the-aligndev-contract)** on a managed project: public URLs from `REMOTE_DEV_DOMAIN` or `REMOTE_DEV_HOST` in the run-file patches, the public URL in the `dev up` summary *(dev server)*, and the README section.
- [ ] **Verify the whole lifecycle** on a throwaway branch. `workspace setup -c <branch>` writes no file carrying ports. `dev setup` there writes the run files with the workspace's own ports *(ports)*. Start its dev server *(dev server)*, then finish with `workspace remove`. On a managed project, also start once with `REMOTE_DEV_DOMAIN` set to a placeholder domain and check the URLs. A wrapper that merely loads proves nothing.
