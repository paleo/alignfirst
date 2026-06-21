# Implementing Worktree-Based Concurrent Local Environments

Blueprint for implementing a workspace system — multiple git-worktree dev environments side by side — in a repository. Requires git. Template scripts are in Node.js but the approach works with any runtime.

Implement a system for running multiple local dev environments side by side via git worktrees. Adapt it to any repository, regardless of tech stack or database engine.

**Node consumers** install the `@paleo/workspace` package and write two custom scripts that build a config object and call `runWorkspace(config)` / `runDevServer(config)`. The package owns the kernel — slot/dev-server registries, port math, branch lifecycle, process-group control, log polling, CLI parsing. Consumers supply project-specific callbacks (`finalizeWorktree`, `printSummary`, optional `purgeInfrastructure`, optional `devServerScript`) plus a `configFiles` list with patch functions, and resolve their own dev-limit ladder.

**Non-Node consumers** reimplement the system from this design doc; the rationale sections below are self-contained.

The `assets/` directory contains reference scripts ([workspace.mjs](../assets/workspace.mjs), [dev-server.mjs](../assets/dev-server.mjs)) — thin wrappers around the package — plus a template for [agent documentation](../assets/workspace.md). The scripts carry `ADAPT` comments and long explanatory blocks — scaffolding to guide _you_, not part of the deliverable. Strip them from the scripts you generate; keep only the rare comment explaining a non-obvious, project-specific choice (e.g. why a file is copied). Aim for lean wrappers.

## Implementation Process

Apply the skill in this order. The per-project decisions live in the [checklist](#checklist-for-adapting-to-a-new-repository); this section is the sequence and its guardrails.

1. **Require a clean working tree.** Run `git status` first. If it is not clean, stop and ask the developer to commit or stash. Testing the CLI commits scaffolding and creates/removes worktrees and branches — safe and reviewable only from a clean baseline.

2. **Investigate.** Read the rest of this document, then inspect the repo to answer every checklist item: current ports and config files, shared vs per-worktree gitignored directories, database provisioning, package manager, and the dev-server's ready / fatal log markers. Note what needs migrating (scattered ports, a config file not yet gitignored, a colliding dev-script name, etc.).

3. **Present findings and plan, then get approval.** Summarize what you found and exactly what you intend to do — base port and port scheme, the shared / per-worktree split, config files to patch, database-provisioning strategy, dev-server command (and any rename), and migrations. **Do not change anything until the developer agrees.**

4. **Implement.** Work through the checklist: install the package, write the two lean scripts, add the npm scripts, migrate ports / config, update `.gitignore`, write the agent docs.

5. **Commit once, then test.** Make a **single commit** with all the scaffolding — a prerequisite for testing, not a wrap-up. `workspace setup <branch> -c` builds the linked worktree from the committed `HEAD`, so the scripts and `package.json` changes must be committed to exist there; the commit also gives the clean tree `workspace remove` expects. Then exercise the CLI end to end:
   - bootstrap the main worktree (`workspace setup`);
   - create a throwaway workspace (`workspace setup <test-branch> -c`);
   - start / stop dev servers (`dev up`, `dev list`, `dev down` / `down --all`);
   - `workspace list` and `status`;
   - remove the throwaway workspace (`workspace remove <test-branch>`), then delete the test branch you created — your own artifact, the one case where deleting a branch is expected.

6. **Fix by amending, then re-test.** When a test surfaces a problem, fix it, fold it into the same commit with `git commit --amend`, and re-run the affected tests. Keep the whole effort as one commit. A common find: a gitignored credential file (e.g. `.npmrc`, a private-registry token) not propagated to new worktrees, so `npm install` fails there — add it to `configFiles` (verbatim copy, usually `optional: true`).

7. **Never push.** Leave the final, amended commit for the developer to review and push.

## The Problem

When you work on multiple branches at the same time (or when AI agents work in parallel), you need isolated environments. Git worktrees give you isolated _code_, but that's not enough: each environment also needs its own ports, its own database, and its own config files. Without automation, setting this up manually for every branch is tedious and error-prone.

## Core Concepts

### Shared vs per-worktree gitignored directories

The first thing to decide is: for each gitignored directory in your project, should it be **shared** across worktrees or **isolated** per worktree?

- **Shared directories** are symlinked in worktrees (pointing to the main worktree). They contain things that should be the same everywhere: the slot registry, personal notes, task plans, etc.
- **Per-worktree directories** are created independently in each worktree. They contain things that must differ: databases, caches, logs, Docker volumes, etc.

Example split:

| Directory      | Shared or per-worktree | Contents                         |
| -------------- | ---------------------- | -------------------------------- |
| `.local/`      | Shared (symlinked)     | Slot registry, personal notes    |
| `.plans/`      | Shared (symlinked)     | Task planning files              |
| `.local-wt/`   | Per-worktree           | Databases, caches, logs          |

The setup script creates symlinks for shared directories and creates fresh copies of per-worktree directories. The naming can be customized.

### Contiguous port scheme

Most projects have scattered default ports: server on 3000, database on 5432, Redis on 6379, frontend on 5173, etc. For the worktree system to work, **all ports must be made configurable and reorganized into a contiguous range** so they can be derived from a single slot number.

For example, a project that originally uses ports 3000, 5432, and 5173 would be reconfigured to use 8100, 8101, and 8102 in the main worktree — and 8110, 8111, and 8112 in worktree slot 8110. This is a one-time migration of the project's dev environment configuration.

**Choose a base port that starts a range of at least 200 contiguous ports that are free on all common operating systems.** Port 8100 is a safe default (range 8100–8299). If a user proposes a different base — such as 8000, which conflicts with common HTTP alternate ports on some systems — advise them to pick a safer one.

Note: Services that run in Docker (like a database) can have their host port remapped without changing the container's internal port.

### Slot-based port allocation

Each worktree gets a unique "slot" that determines its port(s). A central **slot registry** (a JSON file stored in a shared directory) tracks which slots are assigned to which worktrees. The template ships with 19 linked-worktree slots; the main worktree is implicit, for 20 workspaces total.

**Design the port scheme based on how many ports each environment needs.** The template script uses a step of 10 between slots, which leaves room for multiple ports per environment (e.g. frontend=8110, server=8111). Some examples:

- A project with a frontend port and a server port could use slots 8110–8190 (step of 10), assigning e.g. frontend=8110, server=8111.
- A project with frontend, server, and database ports could also use a step of 10, assigning e.g. frontend=8110, server=8111, db=8112.
- A project with only a single port could simplify to a step of 1 (e.g. slots 8101–8109). In that case, remove the `PORT_STEP` constant, the modulo check in `isValidPort()`, and any secondary port derivation from the template script.

The slot is identified by the primary port number itself (e.g., `--slot 8120`).

**Registry format** (stored under the main worktree's `runtimeDir`, e.g. `.local-wt/workspace-registry/slots.json`):

```json
{
  "slots": {
    "8110": { "worktree": "/absolute/path/to/myproject-feat-214", "branch": "feat/214", "owner": "alice" },
    "8130": { "worktree": "/absolute/path/to/myproject-feat-234", "branch": "feat/234" }
  }
}
```

The main worktree is registered at `basePort` (the first slot); linked worktrees occupy `basePort + portStep × k` for k≥1.

### Concurrent dev-server cap

Host RAM is shared. Without a cap, parallel dev-servers (especially when an AI bot fans out worktrees) can exhaust memory. The wrapper passes an optional `devLimit` number to `runDevServer`; omit it for no limit. A hardcoded `5` is a sensible default — bump it if your stack is light, lower it if it's heavy.

A second registry, `.local-wt/workspace-registry/dev-servers.json`, tracks live dev-servers. It lives under the main worktree's `runtimeDir`; linked worktrees reach it via a `workspace-registry` symlink created by `workspace setup`. An entry is **live** if at least one PID in its `pids` map is alive; dead entries are pruned on every read. When `live >= limit`, `dev` / `dev up` aborts and lists the active servers (slot, branch, owner, pids, started-at, worktree path). Re-run with `--evict` to stop the oldest live dev-server across all worktrees and start the new one instead of aborting.

### Config files must be gitignored

The actual config files that contain ports (`.env`, `config.json`, `docker-compose.override.yml`, etc.) **must be gitignored**. This is essential: since all worktrees share the same git history, a tracked config file would be the same everywhere, defeating the purpose of per-worktree port assignment.

The repo contains checked-in _example_ config files (e.g., `.env.example`, `config.example.json`). The setup uses a **two-stage flow**:

1. **Once per repo**, the developer manually creates the main worktree's actual config from the `.example` file (`cp .env.example .env`) and customizes it as needed (e.g., a remote dev-server IP for `API_URL`, secrets, feature flags).
2. **For every sibling worktree**, the setup script copies the main worktree's actual config and patches in the slot's ports. This propagates the developer's customizations automatically.

This means dev-time customizations (a public dev IP, alternate hosts, etc.) flow into new worktrees "for free". The `extractHost` helper preserves non-localhost hosts when patching URL-style env values, so a `API_URL=http://1.2.3.4:8001` becomes `http://1.2.3.4:<newPort>` rather than collapsing to `localhost`.

Trade-off: mistakes in the main worktree's config also propagate. Keep it clean.

## The Two Scripts

### 1. `workspace` — Worktree lifecycle management

This is the central piece. It handles the full worktree lifecycle: creation, setup, and removal. It can create a worktree for an existing branch, create a new branch with automatic deduplication, set up the local environment, and tear everything down.

The package's `runWorkspace(config: WorkspaceConfig)` performs the lifecycle below. See [assets/workspace.mjs](../assets/workspace.mjs) for a populated reference config.

**Lifecycle for setup (with `workspace setup <branch>`):**

1. **Creates the worktree.** Path computed automatically (`../<reponame>-<slug>`). The default slug strips a recognizable ticket suffix from the last branch segment (`feat/ABC-123-extra` → `feat-ABC-123`), caps at 22 chars, and trims trailing dashes. Override via `config.worktreeDirName` (see below). With `-c`, the new branch starts at the current worktree's HEAD, or at any commit-ish via `--from <ref>`; branch-name dedup (appends `-2`, `-3`...) when the name is taken; the directory is independently deduped if a directory of the same name already exists on disk.
2. **Detects worktrees.** Finds the main worktree via `git rev-parse --git-common-dir` (parent of `.git`).
3. **Assigns a slot.** Auto-assigns the first available port, or accepts `--slot PORT`. Records `{ worktree, branch, owner? }` in the slot registry. `owner` is undefined by default; `--owner NAME` sets it; on re-setup without `--owner`, the existing owner is preserved.
4. **Symlinks shared directories** from `config.sharedDirs` (default `[".local", ".plans"]`) to the main worktree using relative paths. On a linked worktree it also creates the `workspace-registry` symlink, pointing the worktree's `${runtimeDir}/workspace-registry` at the main worktree's.
5. **Generates config files** by iterating `config.configFiles`. Each entry is `{ path, source?, patch(content, ctx), optional? }`; the source (the main worktree's `path` by default) is read and run through `patch`. `optional: true` downgrades a missing source from an error to a skip+warning.
6. **Runs `await config.finalizeWorktree(ctx)`** in a detached background process. This callback owns infrastructure startup, dependency install / build, database provisioning, migrations, and seeding (see "Database provisioning" below). It MUST be idempotent — `workspace setup` re-runs it as the documented retry path.
7. **Prints a summary** by calling `config.printSummary(ctx)` and `console.log`-ing the returned string.

**Lifecycle for removal (with `workspace remove [<branch>]`):**

1. Looks up the branch in the slot registry to find the worktree path and slot.
2. Refuses when the worktree has uncommitted changes, unless `--force` is passed.
3. Stops the dev server by shelling out to `node <devServerScript> down` with `cwd: <target worktree>`.
4. Calls optional `config.purgeInfrastructure(ctx)` — destructive teardown (typically `docker compose down -v` to wipe volumes). Runs after the dev-server stop.
5. Frees the slot, drops the matching `dev-servers.json` entry, and removes the worktree via `git worktree remove --force`.

**CLI subcommands:**

| Command | Purpose |
| --- | --- |
| `workspace setup` | Set up the local environment in the current worktree (idempotent; bootstrap/retry path) |
| `workspace setup <branch>` | Create a worktree for an existing branch, then set up the local environment |
| `workspace setup <branch> -c` | Create a new branch (`-c`/`--new-branch`, with suffix dedup) + worktree, then set up. Mirrors `git switch -c`: the branch starts at the current worktree's HEAD, or at any commit-ish via `--from <ref>` |
| `workspace remove [<branch>]` | Stop dev server + free slot + remove worktree by branch, or the current worktree when omitted |
| `workspace list` | Print all registered worktrees (slot, type, status, dev, branch, path, owner, created). The `DEV` column shows `up` when a live dev-server is registered for that slot's worktree, `-` otherwise |
| `workspace status` | Print the summary (ports, branch, readiness) for the current worktree. Status shows elapsed time since `createdAt` / `failure.at` for `pending` / `failed` slots (e.g. `pending, started 4m 12s ago`); a `Dev-server:` block reports whether the dev-server is running, with PIDs and log paths |
| `workspace wait` | Block until the background finalize reaches `READY:` (exit 0, prints the worktree summary) or `FAILED:` (exit 1). Uses the current worktree's slot, or `--slot PORT` to target another. Use for CI / agent orchestration |
| `workspace set-owner <name>` | Update the owner of the current linked worktree's slot — no rebuild |
| `workspace migrate-0.16 <old-registryDir>` | Transitional: merge a pre-0.16 registry into `${runtimeDir}/workspace-registry` and relink worktrees |

Per-subcommand flags: `setup` accepts `-c`/`--new-branch`, `--from <ref>`, `--owner <name>`, `-s`/`--slot <port>`, `--force`, `--wait`; `remove` accepts `--force` (proceed despite uncommitted changes); `status`/`wait` accept `-s`/`--slot <port>`; `-v`/`--verbose` is global. `workspace --help` prints help and exits 0; bare `workspace` (or an unknown command) prints a warning then help and exits 1.

**Config fields to populate:**

- `scriptPath: string` — required. Absolute path to your wrapper script. Pass `fileURLToPath(import.meta.url)`. The package re-spawns this script for the detached finalize phase.
- `devServerScript: string` — required. Absolute path to your `dev-server.mjs`. On `workspace remove`, the kernel shells out to `node <devServerScript> down` with `cwd: <target worktree>`. Set it via `fileURLToPath(new URL("./dev-server.mjs", import.meta.url))`.
- `basePort` — required. The port that anchors the slot range. `8100` is the recommended default.
- `portStep` (default `10`), `maxSlotCount` (default `19`).
- `ports(slot)` or `portNames` — supply either a function returning the port map for a slot, or a list of names that defaults to consecutive ports (`{ name0: slot, name1: slot+1, ... }`).
- `sharedDirs: string[]` — required. Directories symlinked from the main worktree (e.g. `[".local", ".plans"]`).
- `runtimeDir: string` — required. Per-worktree runtime directory relative to the worktree root (e.g. `.local-wt`). Holds the setup log and dev-server logs. The registry lives at `${runtimeDir}/workspace-registry` (`slots.json`, `dev-servers.json`), symlinked to the main worktree per linked worktree by `workspace setup`.
- `configFiles: Array<{ path, source?, patch, optional? }>` — one entry per gitignored config file. `patch(content, { slot, ports, mainWorktree, currentWorktree })` returns the rewritten content. Use `helpers.patchEnvFile` for `KEY=VALUE` files and `helpers.extractHost` to preserve non-localhost hosts. `source` overrides where the initial content comes from (default: `path` read from the main worktree): `{ path }` (relative to the main worktree, e.g. a committed example), `{ content }` (verbatim), or a callback `(ctx) => { path } | { content }` receiving the same `PatchContext`. `optional: true` skips the entry (warning) when a `{ path }` source is missing instead of aborting.
- `finalizeWorktree(ctx)` — required callback. Runs in a detached background process after the foreground command returns. Owns infrastructure startup (e.g. `docker compose up -d`), database readiness wait, `npm install` / build, migrations, and seeding. **MUST be idempotent** — `workspace setup` is the documented retry path and re-runs this same callback. **Run `npm install` first** so any later failure leaves a worktree with usable `node_modules/`; otherwise the `workspace setup` retry can't import `@paleo/workspace`. Failures are logged to `<runtimeDir>/logs/workspace-setup.log` with a `FAILED:` banner.
- `purgeInfrastructure(ctx)` — optional. Called by `workspace remove` after the dev-server stop. The standard pattern is `docker compose down -v` if you use Docker — destructive teardown that wipes volumes, complementing the soft `docker compose down` in the callback `stop()`.
- `printSummary(ctx)` — required. Returns the string to print after the foreground phase (slot creation + symlinks + config files) completes.
- `worktreeDirName?({ branch, repoName })` — optional. Returns the worktree directory basename (e.g. `myrepo-feat-ABC-123`). Defaults to `defaultWorktreeDirName`, which strips a recognizable ticket suffix from the last branch segment (`feat/ABC-123-extra` → `feat-ABC-123`), caps at 22 chars, and trims trailing dashes. The kernel handles dedup (`-2`, `-3`…) when the resulting directory already exists, so the override should stay pure.

### Database provisioning

Each worktree needs its own database instance. The setup script must produce a working database — how it does so depends entirely on your stack.

**File-based databases (SQLite, etc.):** If your database is stored as files on disk, the setup script can simply copy the data directory from the main worktree. This gives the new worktree a clone of the current data. This is the simplest case.

**Docker-managed databases (PostgreSQL, MySQL, etc.):** The template ships an example flow:

1. Copy `docker-compose.yml` from the main worktree into the new worktree, patching the host port (e.g. `5432`) to the slot's DB port and rewriting `container_name` to include the slot (e.g. `myrepo-database-slot-8110`) so containers don't collide.
2. Start the container with `docker compose up -d`.
3. Wait for the DB to accept **TCP** connections: poll `docker compose exec -T database pg_isready -h 127.0.0.1` with a 30-second deadline. The `-h 127.0.0.1` is essential — on a fresh volume Postgres first runs a throwaway Unix-socket-only server for `initdb` (which a plain `pg_isready` reports as ready), then restarts the real server. Gating on TCP, which that init server doesn't listen on, stops the next step from running against it and losing the connection on handoff.
4. Run migrations to set up the schema.
5. Run a seed script to populate initial data.

The slot port can also serve as the basis for naming: e.g., database `myapp_dev_5001` for slot 5001, so databases don't collide even if they share the same database server.

**The principle is the same regardless of tech:** the setup script must end with a worktree that has a functional database, ready for development. What "functional" means and how to get there is project-specific.

### 2. `dev-server` — Background dev server management

This script starts the dev server in the background, waits for it to be ready, and returns. It's designed for AI agents that need to start a dev server, do their work, and stop it — without an interactive terminal.

A "dev server" can be a single process or several cooperating processes (e.g. an API watcher plus a frontend bundler), optionally fronted by infrastructure (Docker, a database). `runDevServer(config: DevServerConfig)` handles either case via `config.servers: ServerDescriptor[]` — one entry per server — but conceptually they form one dev server.

`ServerDescriptor` is a discriminated union on `kind`:

- `kind: "spawn"` — `{ name, exec: { command, args }, port, detectSuccess, detectError? }`. The runner spawns the process with `cwd: ctx.cwd` (= `process.cwd()` at start time), writes stdout/stderr to `<runtimeDir>/logs/<name>.log`, polls the log for readiness, and tracks the PID in `dev-servers.json`. `detectSuccess(logContent) => boolean` decides when the server is ready; `detectError(logContent) => string | false` (optional) returns the matched label of a fatal log pattern, or `false` if none. `port` is the resolved port — read it from your project's existing config file with `helpers.readPortFromEnvFile(file, varName)` or `helpers.readPortFromJsonFile(file, jsonPath)`.
- `kind: "callback"` — `{ name, start(ctx), stop(ctx) }`. The user owns the lifecycle. The runner only invokes `start` (in array order) and `stop` (reverse order). No port, no log polling, no PID. `ctx: ServerContext` is `{ cwd: string }`.

Servers start in array order. The typical layout is a `kind: "callback"` infra entry (Docker, DB) first, then `kind: "spawn"` app servers.

#### Writing `kind: "callback"` servers

The rules below are not enforceable by the type system. Read them carefully:

- `start(ctx)` MUST resolve only once the resource is ready (no log polling on the runner's side).
- Surface a failing command's output and let it throw. Run the startup command with `stdio: "inherit"` (or, on `"pipe"`, print `err.stderr` in the catch) so the real error is visible — never swallow it with an empty `catch {}`. A `start()` that throws aborts cleanly (the runner rolls back and reports it); a `start()` that catches-and-returns falsely signals success, so later servers start against a dead dependency and the root cause is hidden.
- Always thread `ctx.cwd` into every child-process call (`{ cwd: ctx.cwd }` on `execSync`, `spawn`, etc.) and resolve any paths against `ctx.cwd`. Never call bare `execSync("docker compose ...")` — it picks up `process.cwd()` and breaks cross-worktree stop.
- Do not capture paths or env values at module load. Resolve everything inside the callback from `ctx.cwd`.
- Cross-worktree stop (`dev down --all`, eviction) invokes your callbacks with `ctx.cwd = <victim worktree>`, not the worktree the process started in. If a victim worktree is on a branch that declares an extra callback server not present in the current config, that server is skipped — `dev down` from inside that worktree finishes the cleanup.
- Each worktree gets its own Docker stack on slot-scoped ports (host port remap; container port unchanged). `stop()` is local — no reference counting, no shared infra.
- Registry liveness pruning is PID-based on spawn servers. If a user kills the spawn processes manually instead of running `dev down`, the entry is pruned and callback `stop()` never fires (e.g. Docker is orphaned). Always use `dev down`.

See [assets/dev-server.mjs](../assets/dev-server.mjs) for a populated reference config.

**Lifecycle:**

1. Refuses to start when the current worktree's slot in `slots.json` is `pending` or `failed`; prints the elapsed time since creation/failure and the log path.
2. Verifies that each spawn server's `port` is not already in use.
3. Reads `dev-servers.json`, prunes dead entries, and refuses to start when the live count meets `config.devLimit` (omitted = no limit). Pass `--evict` to stop the oldest live dev-server across all worktrees and proceed instead of aborting.
4. Aborts if this worktree already has an entry in `dev-servers.json` whose spawn PIDs are alive. A stale entry (all PIDs dead) is dropped so the start can proceed.
5. Iterates `config.servers` in array order. For `kind: "spawn"`: spawns a detached process group with stdout/stderr to `<runtimeDir>/logs/<name>.log` and records the PID in-memory. For `kind: "callback"`: `await server.start({ cwd: process.cwd() })`.
6. Polls each spawn server's log in parallel and asks `detectSuccess(logContent)` whether it's ready. Fails fast when `detectError(logContent)` returns a label (e.g. matching `"[ExceptionHandler]"` or Node's `"Node.js v"` exit footer) or when the process dies, instead of waiting for the timeout.
7. On any startup failure — a spawn server's `detectError`/death, or a `kind: "callback"` `start()` that throws — stops every spawned sibling process, invokes `stop()` on every callback server that already started (reverse order), and exits non-zero. A spawn failure prints the failing log's tail; a callback failure prints the thrown error's message.
8. On success, registers the dev-server in `dev-servers.json` (slot, worktree, branch, owner, spawn pids keyed by `server.name`, `startedAt`) and calls `config.printSummary?.(ctx)` (or prints a default summary when omitted).

**Foreground vs background:** bare `dev` starts in the foreground — it runs the same start pipeline, registers in `dev-servers.json` (so it counts toward the cap and shows in `dev list`), then holds the terminal and tails each spawn server's log to stdout. CTRL+C runs the local stop (kill spawn PIDs + callback `stop()` reverse + unregister) and exits. `dev up` is the same start without holding the terminal — it returns once ready. Children are spawned detached either way, so a hard-killed foreground parent leaves the children as registered orphans, cleanable via `dev down` / `dev list`.

Stopping the servers from elsewhere — `dev down` / `down --all` from another terminal, eviction, or a manual kill — makes a foreground `dev` exit cleanly instead of hanging on dead servers.

`dev list` prints the active dev-servers (sorted by slot). `dev down --all` stops every spawn process in every entry (graceful, then forced), invokes `stop({ cwd: entry.worktree })` for every `kind: "callback"` server in the current config (reverse order, per victim), and clears the registry.

`dev restart` stops this worktree's dev-server (if running), then starts it in the background — equivalent to `dev up --restart`. `dev status` reports `Dev-server status: UP.` (followed by the start summary) or `Dev-server status: DOWN.` for the current worktree, without changing anything.

**Main worktree:** the main worktree owns the slot at `basePort` in `slots.json`. `dev` / `dev up` / `dev list` / `dev down --all` treat it like any other slot, so it counts toward the cap. `dev list` marks it `type=main`.

A single-process dev server uses a `SERVERS` array with one entry; the script's structure stays the same.

**Two-tier shutdown:**

- **`dev down` (dev-server)**: Kills the spawn-managed processes and runs every `kind: "callback"` server's `stop()` (reverse array order). The standard pattern is `docker compose down` (no `-v`) — containers stop, but volumes persist, so restarting is fast. Foreground CTRL+C runs the same sequence.
- **`workspace remove`**: If the target has an entry in `dev-servers.json`, shells out to `node <devServerScript> down` in the target worktree (which kills the spawn PIDs and runs the callback `stop()` from the target's branch). Then calls `purgeInfrastructure(ctx)` (typically `docker compose down -v`), releases the slot, and removes the worktree directory.

Decide what each callback's `stop()` does based on the soft-stop intent: containers down, data kept. The destructive part (volumes, container removal) lives in `purgeInfrastructure`. Data initialization is the expensive part; the dev server itself starts in seconds.

**Config fields to populate:**

- `basePort` — required (used to synthesize the main worktree's slot).
- `devLimit?` — optional number. The cap on concurrent dev-servers across all worktrees; omit for no limit. Hardcode a sensible value (e.g. `5`) or read it from any source you like.
- `servers: ServerDescriptor[]` — one entry per server. Mix `kind: "spawn"` and `kind: "callback"` entries; declare infra (Docker, DB) as a `kind: "callback"` server, typically first. `detectError` is optional on spawn entries; supply it to fail fast on known fatal log patterns.
- `printSummary?` — optional. Receives `{ slot, servers: [{ server, port?, pid? }, …] }` (`port` and `pid` are present only on `kind: "spawn"` entries) and returns a string to print. The kernel prints a sensible default if you omit it.

## Workflow

### Setting up a new local environment

```sh
npm run workspace -- setup feat/42 -c       # new branch + worktree (dedup: appends -2, -3… if taken)
npm run workspace -- setup feat/456 -c --from origin/feat/123   # new branch based on another branch
# --from accepts any commit-ish (local branch, tag, SHA); without it, the branch starts at the
# current worktree's HEAD, like `git switch -c`.
npm run workspace -- setup feat/42          # new worktree on an existing branch
npm run workspace -- setup                  # set up the current worktree

# Tag a slot's owner (free-form label; useful for AI bots passing a Discord username)
npm run workspace -- setup feat/42 --owner alice
npm run workspace -- set-owner bob          # update later, no rebuild

# Start developing (foreground: holds the terminal, stops on CTRL+C)
npm run dev
# Or, for agents (background):
npm run dev -- up
```

### Removing a local environment

```sh
npm run workspace -- remove feat/42       # remove by branch name
npm run workspace -- remove               # remove the current worktree
npm run workspace -- remove feat/42 --force # discard uncommitted changes in a dirty worktree
```

`workspace remove` (no branch, from inside the worktree) prints the main worktree path. The parent shell's CWD will point to a deleted directory — run `cd <main-worktree>` afterward.

### Stopping the dev server

```sh
npm run dev -- down   # Stop the spawn processes and run callback stop() (e.g. `docker compose down`)
npm run dev -- up     # Later, restart quickly
```

The foreground `npm run dev` stops the same way on CTRL+C.

### Listing and stopping all dev servers

```sh
npm run dev -- list           # List active dev-servers across all worktrees
npm run dev -- down --all     # Stop every active dev-server (kills PIDs + runs callback stop() per worktree)
npm run dev -- up --evict     # If the cap is full, evict the oldest dev-server and start
```

### Creating a worktree without setup

When you only need a worktree (no slot, no config, no install), use `git worktree` CLI directly.

### npm scripts to add

```json
{
  "workspace": "node scripts/workspace/workspace.mjs",
  "dev": "node scripts/workspace/dev-server.mjs"
}
```

The single `dev` script carries every subcommand (`dev`, `dev up`, `dev restart`, `dev down`, `dev list`, `dev status`). Don't name it after the app's own dev command — a spawn server running `npm run dev` would recurse; use a distinct name (e.g. `dev:app`).

## Key Design Decisions and Rationale

**Why symlink shared directories rather than creating separate copies per worktree?**
The slot registry must be shared so all worktrees see the same allocation state. Personal notes and plans should also be accessible from any worktree. Symlinking is the simplest way to achieve this.

**Why does each worktree need its own database?**
Each worktree might run migrations or modify data independently. Sharing a database across concurrent environments would cause conflicts. Each environment gets its own isolated database instance — how that's achieved (file copy, Docker container, etc.) is project-specific.

**Why a Node.js script rather than a shell script?**
The setup logic (JSON parsing, file manipulation, slot allocation) is more maintainable in a real programming language. If your project already has a runtime (Node.js, Python, etc.), writing the script in that language avoids extra dependencies. The template scripts use Node.js, but the approach translates to any language.

**Why detect the main worktree via `git rev-parse --git-common-dir`?**
This works reliably regardless of where worktrees are physically located. The common dir always points to `<main-worktree>/.git`, so its parent is the main worktree.

**Why does the script handle worktree creation instead of relying on manual `git worktree add`?**
Centralizing worktree path computation prevents a common mistake: creating the worktree as a child directory of the main worktree instead of a sibling. The script derives the path automatically from the branch name and the main worktree directory name.

**Why copy configs from the main worktree instead of from `.example` files?**
Sibling worktrees should inherit the developer's main-worktree customizations (e.g., a public dev-server IP overriding `localhost`, alternate hosts, secrets configured once). The `.example` files remain the bootstrap source for the main worktree itself, but stop being the per-worktree source after that — propagating customizations automatically is more valuable than re-deriving from the example each time. This is the default; a consumer who prefers example-derived configs can set a per-entry `source` (e.g. `{ path: "...example" }`), typically gated on a developer-local toggle so the choice stays per-developer rather than per-repo.

## Agent Instructions

If you use AI coding agents, the worktree system only works if agents know about it. There are two pieces to set up:

### 1. Main instruction file (`AGENTS.md` or `CLAUDE.md`)

This is the file the agent reads on every task. It must contain:

- **Conventions that affect workspaces** — branch naming and commit message conventions, because the agent creates branches when setting up workspaces. For example:

  ```markdown
  Branch naming convention: `<type>/<ticket-id>` (e.g., `feat/123`, `fix/123`).
  Commit message convention: conventional commits, e.g., `feat: [#123] add new feature`.
  ```

- **A section about workspaces**. For example:

  ```markdown
  ## Workspaces

  A **workspace** is a git worktree (with its branch) together with its own dev setup: dedicated ports, config files, a database, and a dev server you can bring up or down. Workspaces are isolated from one another, so you can run several branches in parallel.

  Read when relevant:

  - `docs/workspace.md` — Creating/removing workspaces, starting/stopping the dev server.
  ```

Without the conventions, the agent creates branches and commits with inconsistent naming; without the workspaces section, it won't share your vocabulary or discover the procedures.

### 2. Detailed workspace documentation (`docs/workspace.md`)

This is the file referenced above. It contains the step-by-step procedures: how to create a workspace, how to start the dev server, how to tear things down. See [assets/workspace.md](../assets/workspace.md) for a starting point.

The agents need to know:

1. The exact commands to run (the script handles worktree creation, setup, and removal)
2. What guardrails to respect (never delete a branch unless explicitly requested)
3. Where logs and config files live

## Checklist for Adapting to a New Repository

- [ ] **Make all dev ports configurable and contiguous.** Reorganize scattered default ports (3000, 5432, 5173...) into a contiguous range. This is a prerequisite.
- [ ] **Design your port scheme.** How many ports per environment? What's the step between slots? For the base port, use 8100 (or another port that starts a 200-port free range on all common OSes) unless you have a specific reason otherwise.
- [ ] **Identify your config files.** Which files need port patching? Do they already have `.example` versions?
- [ ] **Classify your gitignored directories.** Which are shared (symlinked)? Which are per-worktree?
- [ ] **Decide how to provision the database.** File copy (SQLite)? Docker + migrations + seed (PostgreSQL)? The setup script must end with a working database.
- [ ] **Decide on a success marker.** What does your dev server print when it's ready? This is needed for `dev-server`.
- [ ] **Decide on fatal log markers for `dev-server`** (or leave the array empty). Substrings that mean "unrecoverable startup failure" let the script fail fast instead of waiting for the timeout.
- [ ] **Bootstrap the main worktree's config files manually once** (from `.example` files), since sibling worktrees inherit from the main worktree.
- [ ] **Install `@paleo/workspace`** as a dev-dependency (Node consumers).
- [ ] **Write `workspace`** using [assets/workspace.mjs](../assets/workspace.mjs) as a starting point. Search for `ADAPT` comments — then strip them (and the other scaffolding comments) from your final script.
- [ ] **Write `dev-server`** using [assets/dev-server.mjs](../assets/dev-server.mjs) as a starting point. Same approach: adapt, then leave a lean script.
- [ ] **Add npm scripts** (or Makefile targets, etc.): `workspace` and a single `dev` (don't reuse the app's own dev script name).
- [ ] **Set the dev-server cap** by passing `devLimit` to `runDevServer` (default `5`).
- [ ] **Update `.gitignore`** to ignore your shared and per-worktree directory (e.g. `.local-wt/`).
- [ ] **Write agent documentation** if applicable (see [assets/workspace.md](../assets/workspace.md)).
- [ ] **Update your main instruction file** (`AGENTS.md` / `CLAUDE.md`) with a pointer to the agent documentation and any conventions (branch naming, commit messages) the agent needs to follow.
