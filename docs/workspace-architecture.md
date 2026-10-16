---
title: Workspace Package Architecture
summary: Internals of the `@alignfirst/workspace` kernel — foreground self-exit, stop/teardown signal mechanics, cross-worktree callback dispatch, the `workspace remove` re-exec, the concurrency-cap race, port allocation, registry liveness, registry paths and lock, and the old-registry migration. Complements the workspace setup blueprint (`skills/alignfirst-setup-guide/references/workspace-setup.md`), the consumer-facing guide.
read_when:
  - onboarding to the @alignfirst/workspace codebase
  - changing dev-server start/stop, foreground, or eviction behavior
  - debugging an orphaned process, a leaked container, or a registry inconsistency
  - changing how `workspaces.json` is read or written
  - changing port allocation, `dev setup` or `setup --full`
  - touching cross-worktree stop or `workspace remove`
---

# Workspace Package Architecture

For the consumer-facing blueprint — concepts, config fields, the CLI surface, and how to adapt the system to a repository — see the [workspace setup blueprint](../skills/alignfirst-setup-guide/references/workspace-setup.md). This document covers package internals and edge-case behavior that don't belong in that guide.

## Setup modes

`workspace setup` creates the worktree synchronously, then runs `finalizeWorkspace` (install, build) in a **detached child** that streams to `<runtimeDir>/logs/workspace-setup.log`.

The child is spawned as `__finalize` with no target argument and `cwd` set to the new worktree. It re-detects that worktree and takes its basename as the workspace name — the registry key — so parent and child agree on the target with nothing passed between them. Only `--force` and `--full` are forwarded.

- **Blocking (default).** After spawning the child, `runSetup` calls `waitForWorkspace`, which polls `workspaces.json` until the finalize child marks the workspace `ready` or `failed`. During the wait it shows a ticker: a single status line `Finalizing… <label> (<elapsed>) — tail: <log>`, rewritten in place on a TTY and re-emitted on label change otherwise. `--verbose` replaces the ticker with a live follow of the setup log from its current size (the pre-finalize lines were already printed); on settle, one final drain read prints the log bytes written since the last poll.
- **Detached (`-d`/`--detached`).** `runSetup` returns right after spawning the child, printing `Setup continuing in background.` plus a `wait` hint. The caller joins later with `workspace wait`, which runs the same ticker; its `--verbose` first replays the last 30 log lines, since the joiner saw no history. `--enter` enters the worktree immediately in this mode (it already exists), while finalize keeps running.

### Failure before the finalize spawn

`registerWorkspace` writes the entry as `pending`, and a plain `setup` refuses a `pending` entry (`refuseIfFinalizePending`, bypassed by `--force`). An error in the pre-finalize phase that follows — `preSetup`, seeding, `formatSummary` — is therefore caught in `runSetup`: it appends `FAILED: <message>` and the stack to the setup log, marks a `pending` entry `failed` (`markWorkspaceFailed`), and rethrows. A `failed` entry passes the pending check, so the retry after any setup failure is a plain `setup`. A `ready` entry keeps its status: an already-finalized main worktree whose `preSetup` refuses stays usable and is not re-finalized. `copyAndPatchFile` throws a `WorkspaceError` on a missing required source or a non-idempotent patch for the same reason: a `process.exit` there would skip the catch.

### `--full`

`setup --full` adds the dev step. It is refused up front when the config declares no `devServerScript`.

After `finalizeWorkspace` succeeds, the finalize child reports the progress label `Dev setup` and runs `node <devServerScript> setup --from-finalize` in the worktree, its output in the setup log. The entry is still `pending` at that point; the internal `--from-finalize` flag makes the readiness check of `dev setup` accept it.

The child then marks the workspace `ready` whatever the outcome. `ready` means the workspace's own setup succeeded; the dev side is tracked by `devSetupAt` and `devSetupFailure`, and the next `dev setup` or start retries it. The dev-server records its own failures. When it exits non-zero without a record newer than the step's start (it could not run, or stopped at its readiness check or earlier), the child records `dev setup exited with code <n>`.

The blocking `setup --full` and the standalone `wait` report a `ready` entry with a `devSetupFailure` as ``Workspace ready; dev setup failed: <message>. Run `dev setup` to retry.``, and exit 1. `registerWorkspace` drops the `devSetupFailure` of an earlier run, so `wait` reports only the current setup's dev failure.

On a workspace already `ready`, the finalize child skips, so no dev step runs there. The calling process runs it after the wait instead, in the foreground with inherited stdio and without `--from-finalize`, and records a failure the same way.

### Progress file

The blocking ticker cannot call into the detached child, so they communicate through a file: `<runtimeDir>/logs/workspace-setup.progress`. `FinalizeContext.progress(label)` overwrites it with the current label (and appends `PROGRESS: <label>` to the log); the ticker re-reads it each poll. It is deleted when the log is truncated at the start of `setup` and when finalize settles (ready or failed), so a stale label never leaks into the next run.

### Branch-name conflicts

Git refs are hierarchical: `refs/heads/test` cannot coexist with anything under `refs/heads/test/`. `createBranch` treats a name as **taken** when the exact ref exists (local or `origin/`) **or** a ref exists under its namespace, and refuses with a `WorkspaceError` that names the conflict. `--dedupe` opts into the suffix loop (`test-2`, `test-3`…), preferring a candidate whose branch name and worktree directory are both free so the two stay aligned. An **ancestor** conflict (requesting `test/abc` while branch `test` exists) can never be suffixed away, so it always fails, even with `--dedupe`. The worktree-directory dedupe (`dedupeWorktreePath`) is always on and independent of `--dedupe`.

## Foreground self-exit

A foreground `dev` ([`runForeground`](../packages/workspace/src/dev-server.ts)) runs the same start pipeline as `dev up`, but the servers are spawned **detached** (each in its own process group) and only their **child PIDs** are registered in `dev-servers.json`. The foreground Node parent itself is never in the registry — so nothing else can find it to signal it.

Logs stream from the **first byte**: tailing starts via an `onSpawned` hook fired right after the spawn loop, *before* the readiness wait, so a slow startup (build, `docker compose up`) is visible live rather than appearing only once ready. Because the log is streamed in full, a startup failure skips the redundant 30-line tail (`handleStartupFailure` with `includeTail: false`) and prints only the error reason and the full-log path.

### Attach mode

If a dev-server is **already running** in this worktree (e.g. started via `dev up`), a plain `dev` does not start a second one — it [`attachForeground`](../packages/workspace/src/dev-server.ts)s: replays the last `LOG_TAIL_LINES` of the log, follows it live, and exits when the server stops (same `watchForExternalStop` poll as a fresh foreground). The attached session **does not own** the server, so CTRL+C only **detaches** (prints a notice and exits 0, leaving the server running) — unlike a fresh foreground, where CTRL+C runs the full local stop. `dev --restart` skips attach and replaces the running server.

Three things can end a foreground session, all routed through a shared `shuttingDown` guard so only the first wins:

1. **CTRL+C before startup finishes** — the SIGINT/SIGTERM handler runs `rollbackStart` (kill whatever spawned so far, reverse-stop started callbacks) and exits 130.
2. **CTRL+C after startup** — the handler runs the full local stop (`stopLocal`: kill spawn PIDs + callback `stop()` in reverse + unregister + sweep ports), prints `Stopped.`, exits 0. This is the path that *owns* its servers.
3. **Servers stopped from elsewhere** — `watchForExternalStop` polls the foreground's own spawn PIDs every `LIVENESS_POLL_MS` (1000ms). When none remain alive, the servers were killed by `dev down` / `down --all` / eviction in another terminal, or by a manual `kill`. The watcher prints `Dev-server stopped externally (e.g. \`dev down\`). Exiting.` and exits 0.

### Why the external path runs no callback `stop()`

On the external path the foreground deliberately does **not** run callback cleanup, for two reasons:

- Whoever stopped the servers already owns it. `dev down` / `down --all` / eviction kill the spawn PIDs **and** run the callbacks **and** unregister. Their kill→callbacks→unregister window is multi-second (a `docker compose down` is slow), so a second `docker compose down` fired by the foreground would race the first one mid-teardown.
- A manual `kill` of a spawn PID leaks callbacks (e.g. an orphaned Docker stack) — but that is the same behavior everywhere in the system, because liveness pruning is PID-based (see [Registry liveness](#registry-liveness)). The foreground matching it is consistent, not a new gap.

So on external stop the foreground's only job is to stop hanging on dead servers and exit cleanly.

## Stop and teardown signal mechanics

`stopProcessGroup(pid, 10_000)` ([`process-control.ts`](../packages/workspace/src/process-control.ts)) sends `SIGTERM` to the **process group** (`process.kill(-pid, …)`, falling back to the bare pid), polls liveness every 300ms, and escalates to `SIGKILL` if the group is still alive at the 10s deadline. Because spawn servers are detached group leaders, signaling the group reaches the whole child tree (e.g. a dev server and the watchers it forks).

- `dev down` (`stopLocal`) — for the current worktree's entry: `stopProcessGroup` each live spawn PID, run callback `stop()` in reverse array order, unregister, sweep stale ports.
- `dev down --all` (`stopAllRegistered`) — the same per entry across **every** worktree, then clears the whole registry.
- Eviction — stops the oldest live entries (by `startedAt`) to free room under `maxConcurrentDevServers`, using the same primitives.

## Cross-worktree callback dispatch

`dev down --all` and eviction must stop callback servers (Docker, DBs) in worktrees other than the current one. The kernel can't load each victim's config, so it **reuses the current process's loaded callbacks**, invoking each with `ctx.cwd = <victim worktree>`. `ctx.ports` holds the victim worktree's ports, read from its registry entry. This works because every worktree of a repo runs the same dev-server script with the same callback set.

Consequences for callback authors:

- A callback's `stop(ctx)` may run with `ctx.cwd` pointing at a *different* worktree than the one the process started in. Thread `ctx.cwd` into every child-process call and resolve every path against it; capture nothing at module load.
- If a victim worktree is on a branch that declares an **extra** callback server not present in the current config, that server is skipped — running `dev down` from inside that worktree finishes the cleanup.

## The `workspace remove` re-exec

`workspace remove` shells out to `node <devServerScript> down` with `cwd: <target worktree>` rather than stopping the dev-server in-process. This is structural: the `workspace` script doesn't import the dev-server config, so it cannot dispatch callbacks itself. Delegating to the target's own `dev-server.mjs` is how the kernel reaches the callbacks defined on the target's branch. A config declaring no `devServerScript` skips the shell-out. Only after that does `remove` run `purgeInfrastructure` (e.g. `docker compose down -v`), drop the registry entry, and `git worktree remove --force`. Before any of these teardown steps, `remove` refuses when the worktree has uncommitted changes, unless `--force` is passed.

## Concurrency-cap TOCTOU race

The cap check and the subsequent register in `enforceCap` are not atomic. Two concurrent `dev up --evict` from different worktrees can both pass the check and both register, leaving `maxConcurrentDevServers + 1` live servers. This is accepted: the window is narrow and the consequence is bounded to one extra server. Resolve manually with `dev list` + `dev down`.

## Registry liveness

An entry in `dev-servers.json` is **live** when at least one of its spawn PIDs is alive; dead entries are pruned on every read. Liveness is purely PID-based on spawn servers — it knows nothing about callback-managed infrastructure. So if a user kills the spawn processes manually instead of running `dev down`, the entry is pruned but the callback `stop()` never fires and infrastructure (e.g. a Docker stack) is orphaned. Always stop via `dev down`.

## Port allocation

`dev setup` ([`dev-setup.ts`](../packages/workspace/src/dev-setup.ts)) runs explicitly, and implicitly before `up`, `restart` and the foreground start. It resolves the workspace, requires the `ready` status, reconciles the ports, writes the run files, then runs `DevServerConfig.setup` when `devSetupAt` is unset or `--force` is given. In the main worktree, it first re-keys a renamed main entry, or creates a `ready` main entry when there is none. That entry carries `neverFinalized: true`, so a later `workspace setup` still finalizes the main worktree. A failure after the readiness check is recorded as `devSetupFailure`; a successful run clears it.

### Reconciliation

`reconcilePorts` ([`ports.ts`](../packages/workspace/src/ports.ts)) is pure. It takes the resolved config, the workspace's stored ports, the ports stored on every other entry, and a probe. Then, in `names` order:

1. In the main worktree, each `declare` entry with a `mainWorktree` takes its pinned port.
2. A stored port is kept when the config still allows it for its name and nothing reserves it. An allowed port is inside the range, not excluded, not a bad port, and inside the name's dedicated range, or outside every dedicated range for a name without one. A port is reserved when it is pinned, already assigned to another name of the workspace, or, in a linked workspace, stored on another entry.
3. Each missing name gets the lowest port of its scope that is allowed for it, neither pinned nor assigned, stored on no other entry, and free according to the probe. The scope is the name's dedicated range, or the project range. Each scope keeps its own cursor, so a rejected port is never probed twice.

An undeclared name is not carried over, so its port is freed. An exhausted scope is a `WorkspaceError` that names the range and points at `workspace remove`. For a dedicated range, it adds that ports held there under other names are freed at those workspaces' next `dev setup`. `--reset-ports` passes no stored port, so every port is allocated again, pins excepted. It refuses first while the worktree's dev-server runs. When the ports change, they are printed as one `Ports: …` line.

### Lock and probe

The reconciliation runs inside `updateWorkspaces` ([Registry lock](#registry-lock)), listen probes included, so two worktrees never allocate the same port. `isPortFree` listens exclusively on `127.0.0.1`, then `::1`. `EADDRINUSE` or `EACCES` means busy; a host without IPv6 skips the second probe.

The probe is a snapshot. A process that binds the port later is caught at start by `checkPortsFree`, whose error points at `dev setup --reset-ports`. For a pinned port in the main worktree, it says to free the port or change the entry's `mainWorktree` instead.

### Bad ports

`BAD_PORTS` holds the Fetch Standard's bad-port list: the ports browsers refuse to load, such as 6000, 6665–6669 and 10080. Allocation never picks one, and a pin on one is a `ConfigError`.

### Pins and older branches

Each worktree reads its own branch's dev-server config, so a linked branch older than a pin knows nothing of it. The registry closes that gap: allocation skips every port stored on any entry, and a linked workspace drops a stored port that another entry also holds, the main entry winning.

One window remains. Before the main worktree's first `dev setup` after the pin, an older branch may allocate the pinned port. The main worktree then takes it anyway, and the start-time check reports the collision until the linked workspace's next start moves it.

### Dedicated ranges and older branches

Adding a dedicated range moves no port of another workspace from the outside. Each workspace frees the ports it holds in the range under other names at its next `dev setup`, also run before every start. Until then, the range offers fewer ports. A linked branch whose config predates the range can also take a port there for another name. Both are accepted: the dedicated-range exhaustion message covers them.

### Run files

`seedFiles` ([`file-entries.ts`](../packages/workspace/src/file-entries.ts)) writes both file lists through `copyAndPatchFile`: `workspace setup` the `gitignoredFiles` with a `PatchContext`, `dev setup` the `runFiles` with a `RunFileContext`, which adds `ports`. An existing file gets its `patch` re-applied and is rewritten only when the result differs. `copyAndPatchFile` refuses a patch that is not idempotent, on a seed as on a re-apply, before writing. The rewritten files are reported in one `Updated <paths>` line, printed even when a later entry fails. `workspace setup --force` reseeds a `gitignoredFiles` entry from its source. No flag reseeds a run file: a deleted one is created again at the next `dev setup`.

### Legacy entries

`readWorkspaces` drops a legacy `portIndex`. Those workspaces get new ports at their next start, and their run files are re-patched then. A `ready` legacy entry also gets `devSetupAt` ([Read-time repair](#read-time-repair)), so its next start skips `setup`.

## Port claim check

Every dev-server command runs `checkPortClaim` ([`port-claim.ts`](../packages/workspace/src/port-claim.ts)) before dispatching. It compares `first` and `last` of `DevServerConfig.ports` with `portRange` in the current worktree's `.alignfirst.json`. A missing file skips the check. A mismatch, a `ports` group without `portRange`, or a `portRange` without a `ports` group is a `ConfigError`. The `alignfirst` CLI owns the file's schema; the kernel reads only the two range integers.

## Registry paths and repair

`workspaces.json` stores each `worktree` as an absolute path, like `dev-servers.json`. All worktrees share the file through the registry symlink while each branch runs its own package version, and every version reads absolute paths alike.

The file carries `"version": 2`. A file without it was written by 0.36 or older. Older versions keep the top-level key when they rewrite the file.

### Read-time repair

`readWorkspaces` repairs every entry in memory, and the next write persists the repair:

- A `main: true` entry points at the main worktree, so the main worktree can move alone.
- A relative path, written by an earlier build, is resolved against the main worktree. The repaired path is always absolute.
- An existing path is kept. Linked worktrees therefore survive a move of the main worktree.
- A missing path whose sibling `join(dirname(mainWorktree), <key>)` exists points at that sibling: the project moved together with its worktrees.
- Any other missing path is kept. The entry stays an orphan.

In a file without `version`, a `ready` entry without `devSetupAt` gets its `createdAt`: its old `finalizeWorkspace` already provisioned the infrastructure.

An old bug left one main entry per name the main directory ever had. `readWorkspaces` keeps the one keyed `basename(mainWorktree)`, otherwise the newest by `createdAt`, and drops the others.

### Main-entry re-key

The main entry is found by `main: true`, not by its key. A key that differs from `basename(mainWorktree)` means a renamed directory, and `rekeyMainEntry` moves the entry under the new name. The entry keeps `createdAt`, `status`, `ports` and `purgeData`, and loses `devSetupAt`: infrastructure is named after the workspace, so the next `dev setup` provisions it under the new name. `registerWorkspace` and the main worktree's `dev setup` re-key before their name-collision check, and warn that resources named after the old name are not reused. Renaming the directory back recovers them; otherwise the user removes them by hand. When another entry already holds the new name, the re-key is skipped and the collision check reports it.

### Registry lock

Every read-modify-write of `workspaces.json` goes through `updateWorkspaces`, which holds `<registryDir>/workspaces.lock` ([`registry-lock.ts`](../packages/workspace/src/registry-lock.ts)). The writers are `registerWorkspace`, the `markWorkspace*` functions, the dev-failure record of `setup --full`, `remove`, `prune`, the `list` auto-prune and `migrate-registry-0.30`. The dev-server writes through it too: `dev setup` creates the main entry, stores the ports, `devSetupAt` and `devSetupFailure`.

- The lock file is created with `O_EXCL` and holds `<pid>:<token>`, a token unique to the holder. The `finally` deletes it only while it still holds that token.
- A lock is stale when its PID is dead or the file is older than 30 seconds. A file without a PID yet is judged by its age only. A waiter renames a stale lock to a unique name before deleting it, so only one waiter replaces it. A rename that caught a fresh lock, told apart by its content, puts it back. A third process that creates a lock during that window overlaps the restored holder; closing it would need OS-level locks.
- A waiter retries every 50 ms and fails after 10 seconds, with an error naming the lock file.

The lock covers only reading, changing and writing the JSON, plus the listen probes of the allocation. It never spans a callback, git, Docker or a shell-out. `remove` and `prune` therefore take it twice: once to read the entry, then to delete it after the teardown, on a fresh read. `prune` deletes only the names still orphaned at that read. The `list` auto-prune first looks for orphans without the lock, so a `list` with no orphan writes nothing. Read-only paths (`wait`, `status`, the dev-server's lookups) read without the lock. `writeWorkspaces` writes a temporary file next to `workspaces.json` and renames it over the registry, so they never see a half-written file.

## Registry migration

`workspace migrate-registry-0.30` converts a pre-`workspaces.json` registry (`slots.json`, keyed by port) in place, from the main worktree only. Every other command fails fast while `slots.json` exists, so an old registry never reads as "no workspaces". Worktrees, their gitignored content and running dev-servers are untouched.

Conversion rules:

- All entries describing the main worktree collapse into one, keyed by the real main worktree. Old registries accumulate stale main entries when `basePort` changes, and their recorded paths go stale when the repository moves on disk; the collapse absorbs both.
- Linked entries are keyed by `basename(worktree)`; same-path duplicates keep the newest entry. An entry whose directory is missing migrates as-is — it is an orphan, and the healing machinery reaches it by name.
- Migrated entries carry no ports. Each workspace gets its ports and run files at its next start.
- `dev-servers.json` entries are rekeyed from `slot` to the workspace name; running PIDs stay valid.
- The converted registry is written under the registry lock, with `version`. Its `ready` entries get `devSetupAt`, as in the read-time repair.

The command cannot rename slot-derived infrastructure (containers, volumes). When the config declares `purgeInfrastructure` — the marker of a consumer that tears down by name — it warns that old-named resources must be removed manually.

A `slots.json` present next to an existing `workspaces.json` was re-created after the migration, by a workspace command run on a branch that still uses the old package. `migrate-registry-0.30` then refuses and asks for a manual delete, instead of guessing which registry is authoritative.

## Self-healing orphaned workspaces

A workspace becomes **orphaned** when its worktree directory is deleted out-of-band — a manual `rm -rf`, a bare `git worktree remove`, never going through `workspace remove`. Three pieces of state then go stale: the `workspaces.json` entry (points at a missing path), a possible `dev-servers.json` entry (its detached spawn PIDs can outlive the deleted `cwd`, and PID-based liveness keeps it "live"), and git's own `.git/worktrees/<name>` admin files.

Orphans are found by name (`findOrphanNames`): the registry key outlives the directory it points at, so `prune`, `remove <name>` and the `list` auto-prune all reach an orphan by its basename.

Healing splits by destructiveness:

- **Automatic (safe bookkeeping).** `workspace list` drops the `workspaces.json` (and matching `dev-servers.json`) entry for any orphan with **no live dev-server PIDs** — same harmless pruning as the existing dead-PID sweep. It runs **no** teardown (no `stopProcessGroup`, no `purgeInfrastructure`): `list` stays free of process- and infrastructure-side effects. Orphans whose dev-server is still running are left in place and surfaced with a `workspace prune` hint.
- **Explicit (active heal).** `workspace prune` stops every orphan's live spawn PIDs (`stopProcessGroup`), runs `purgeInfrastructure` for each (see below), drops both registry entries, then runs `git worktree prune` to clear git's stale admin files.

`workspace remove` against an already-deleted worktree dir takes the same direct-kill path (shared `stopOrphanedDevServer` helper): it can't shell out to `node <devServerScript> down` (the worktree and its `dev-server.mjs` are gone), so it kills the recorded spawn PIDs, runs `purgeInfrastructure`, drops both registry entries, and runs `git worktree prune` — same full cleanup as `workspace prune`.

**Tearing down an orphan's infrastructure.** The kernel still can't run a deleted worktree's callback `stop()` — its dev-server config is gone. It runs `config.purgeInfrastructure` instead: the workspace config is loaded, and it lives in the main worktree, so it outlives the deleted worktree. The hook receives `PurgeContext` (`worktree`, `mainWorktree`, `name`, `purgeData`, `verbose`), with `ctx.worktree` pointing at the now-missing dir.

The hook tears down by name. The consumer's `DevServerConfig.setup` names every resource after the workspace, and records a resource with only a random id in a file named after the workspace, under the main worktree. No teardown state is stored in the registry, so a partial `setup` is torn down like a complete one, and the hook runs whether or not `dev setup` ever succeeded.

`purgeData` is legacy: the blob an old `finalizeWorkspace` returned, still carried by the entries created before teardown by name. `migrate-registry-0.30`, `registerWorkspace` and the main-entry re-key carry it over; new code never sets it. The kernel never reads it, only couriers it.

Two residual gaps remain. A consumer that defines no `purgeInfrastructure` still leaks; `prune` prints the generic caveat then. The side-effect-free `list` auto-prune purges nothing; consumers cover it by making `setup` idempotent against leftover infra (force-remove the container named after the workspace before `docker compose up`).

## Rendering `--guide`

`workspace --guide` prints `templates/guide.md`, expanded by [`guide.ts`](../packages/workspace/src/guide.ts). The prose lives in the template; the command blocks stay in code, so their `#` comments align whatever the package-manager prefix costs (`npm run workspace -- ` against `pnpm workspace `).

One config-driven flag gates the template: `DEV`, on when a `devServerScript` is declared. `{{#DEV}}…{{/DEV}}` keeps a block when the flag is on, `{{^DEV}}…{{/DEV}}` when it is off. Markers own their line and one regex handles both forms, so a stripped block leaves no stray blank line. A setup-only project therefore reads a guide with no dev-server section and a workspace definition that mentions only symlinks and config files.
