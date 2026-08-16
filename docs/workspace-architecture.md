---
title: Workspace Package Architecture
summary: Internals of the `@paleo/workspace` kernel — foreground self-exit, stop/teardown signal mechanics, cross-worktree callback dispatch, the `workspace remove` re-exec, the concurrency-cap race, port-block allocation, registry liveness, and the old-registry migration. Complements the workspace setup blueprint (`skills/alignfirst-setup-guide/references/workspace-setup.md`), the consumer-facing guide.
read_when:
  - onboarding to the @paleo/workspace codebase
  - changing dev-server start/stop, foreground, or eviction behavior
  - debugging an orphaned process, a leaked container, or a registry inconsistency
  - touching cross-worktree stop or `workspace remove`
---

# Workspace Package Architecture

For the consumer-facing blueprint — concepts, config fields, the CLI surface, and how to adapt the system to a repository — see the [workspace setup blueprint](../skills/alignfirst-setup-guide/references/workspace-setup.md). This document covers package internals and edge-case behavior that don't belong in that guide.

## Setup modes

`workspace setup` creates the worktree synchronously, then runs `finalizeWorktree` (install, build, DB) in a **detached child** that streams to `<runtimeDir>/logs/workspace-setup.log`.

The child is spawned as `__finalize` with no target argument and `cwd` set to the new worktree. It re-detects that worktree and takes its basename as the workspace name — the registry key — so parent and child agree on the target with nothing passed between them. Only `--force` is forwarded.

- **Blocking (default).** After spawning the child, `runSetup` calls `waitForWorkspace`, which polls `workspaces.json` until the finalize child marks the workspace `ready` or `failed`. During the wait it shows a ticker: a single status line `Finalizing… <label> (<elapsed>) — tail: <log>`, rewritten in place on a TTY and re-emitted on label change otherwise. `--verbose` replaces the ticker with a live follow of the setup log from its current size (the pre-finalize lines were already printed); on settle, one final drain read prints the log bytes written since the last poll.
- **Detached (`-d`/`--detached`).** `runSetup` returns right after spawning the child, printing `Setup continuing in background.` plus a `wait` hint. The caller joins later with `workspace wait`, which runs the same ticker; its `--verbose` first replays the last 30 log lines, since the joiner saw no history. `--go` enters the worktree immediately in this mode (it already exists), while finalize keeps running.

### Progress file

The blocking ticker cannot call into the detached child, so they communicate through a file: `<runtimeDir>/logs/workspace-setup.progress`. `SetupContext.progress(label)` overwrites it with the current label (and appends `PROGRESS: <label>` to the log); the ticker re-reads it each poll. It is deleted when the log is truncated at the start of `setup` and when finalize settles (ready or failed), so a stale label never leaks into the next run.

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
- Eviction — stops the oldest live entries (by `startedAt`) to free room under `devLimit`, using the same primitives.

## Cross-worktree callback dispatch

`dev down --all` and eviction must stop callback servers (Docker, DBs) in worktrees other than the current one. The kernel can't load each victim's config, so it **reuses the current process's loaded callbacks**, invoking each with `ctx.cwd = <victim worktree>`. This works because every worktree of a repo runs the same dev-server script with the same callback set.

Consequences for callback authors:

- A callback's `stop(ctx)` may run with `ctx.cwd` pointing at a *different* worktree than the one the process started in. Thread `ctx.cwd` into every child-process call and resolve every path against it; capture nothing at module load.
- If a victim worktree is on a branch that declares an **extra** callback server not present in the current config, that server is skipped — running `dev down` from inside that worktree finishes the cleanup.

## The `workspace remove` re-exec

`workspace remove` shells out to `node <devServerScript> down` with `cwd: <target worktree>` rather than stopping the dev-server in-process. This is structural: the `workspace` script doesn't import the dev-server config, so it cannot dispatch callbacks itself. Delegating to the target's own `dev-server.mjs` is how the kernel reaches the callbacks defined on the target's branch. A config declaring no `devServerScript` skips the shell-out. Only after that does `remove` run `purgeInfrastructure` (e.g. `docker compose down -v`), drop the registry entry, and `git worktree remove --force`. Before any of these teardown steps, `remove` refuses when the worktree has uncommitted changes, unless `--force` is passed.

## Concurrency-cap TOCTOU race

The cap check and the subsequent register in `enforceCap` are not atomic. Two concurrent `dev up --evict` from different worktrees can both pass the check and both register, leaving `devLimit + 1` live servers. This is accepted: the window is narrow and the consequence is bounded to one extra server. Resolve manually with `dev list` + `dev down`.

## Registry liveness

An entry in `dev-servers.json` is **live** when at least one of its spawn PIDs is alive; dead entries are pruned on every read. Liveness is purely PID-based on spawn servers — it knows nothing about callback-managed infrastructure. So if a user kills the spawn processes manually instead of running `dev down`, the entry is pruned but the callback `stop()` never fires and infrastructure (e.g. a Docker stack) is orphaned. Always stop via `dev down`.

## Port blocks and stale entries

The `ports` config group is resolved once per invocation, and a workspace's ports are derived from its stored block index (`base + perWorkspace × index`) — never persisted. Editing `names`, `perWorkspace` or `base` therefore re-derives every workspace's ports on the next command; re-running `workspace setup` in each worktree is what rewrites the config files to match.

Indexes are allocated only when `ports` is configured. A workspace registered while the config was portless carries no `portIndex`, so declaring `ports` later leaves it **stale**: any command needing its ports fails with a message pointing at `workspace setup --force` in that worktree, and `list` shows `?` in its `PORTS` column. The main worktree is never stale — its index is 0 by definition, and never stored.

## Registry migration

`workspace migrate` converts a pre-`workspaces.json` registry (`slots.json`, keyed by port) in place, from the main worktree only. Every other command fails fast while `slots.json` exists, so an old registry never reads as "no workspaces". Worktrees, their gitignored content and running dev-servers are untouched.

Conversion rules:

- All entries describing the main worktree collapse into one, keyed by the real main worktree. Old registries accumulate stale main entries when `basePort` changes, and their recorded paths go stale when the repository moves on disk; the collapse absorbs both.
- Linked entries are keyed by `basename(worktree)`; same-path duplicates keep the newest entry. An entry whose directory is missing migrates as-is — it is an orphan, and the healing machinery reaches it by name.
- With `ports` configured, the block index is derived from the old slot (`(slot − base) / perWorkspace`). A slot that does not fit the scheme migrates without an index — the stale-entry state, fixed by `workspace setup --force` in that worktree.
- `dev-servers.json` entries are rekeyed from `slot` to the workspace name; running PIDs stay valid.

The command cannot rename slot-derived infrastructure (containers, volumes). When the config declares `purgeInfrastructure` — the marker of a consumer that tears down by name — it warns that old-named resources must be renamed or removed manually.

A `slots.json` present next to an existing `workspaces.json` was re-created after the migration, by a workspace command run on a branch that still uses the old package. `migrate` then refuses and asks for a manual delete, instead of guessing which registry is authoritative.

## Self-healing orphaned workspaces

A workspace becomes **orphaned** when its worktree directory is deleted out-of-band — a manual `rm -rf`, a bare `git worktree remove`, never going through `workspace remove`. Three pieces of state then go stale: the `workspaces.json` entry (points at a missing path), a possible `dev-servers.json` entry (its detached spawn PIDs can outlive the deleted `cwd`, and PID-based liveness keeps it "live"), and git's own `.git/worktrees/<name>` admin files.

Orphans are found by name (`findOrphanNames`): the registry key outlives the directory it points at, so `prune`, `remove <name>` and the `list` auto-prune all reach an orphan by its basename.

Healing splits by destructiveness:

- **Automatic (safe bookkeeping).** `workspace list` drops the `workspaces.json` (and matching `dev-servers.json`) entry for any orphan with **no live dev-server PIDs** — same harmless pruning as the existing dead-PID sweep. It runs **no** teardown (no `stopProcessGroup`, no `purgeInfrastructure`): `list` stays free of process- and infrastructure-side effects. Orphans whose dev-server is still running are left in place and surfaced with a `workspace prune` hint.
- **Explicit (active heal).** `workspace prune` stops every orphan's live spawn PIDs (`stopProcessGroup`), runs `purgeInfrastructure` for each (see below), drops both registry entries, then runs `git worktree prune` to clear git's stale admin files.

`workspace remove` against an already-deleted worktree dir takes the same direct-kill path (shared `stopOrphanedDevServer` helper): it can't shell out to `node <devServerScript> down` (the worktree and its `dev-server.mjs` are gone), so it kills the recorded spawn PIDs, runs `purgeInfrastructure`, drops both registry entries, and runs `git worktree prune` — same full cleanup as `workspace prune`.

**Tearing down an orphan's infrastructure (`extra`).** The kernel still can't run a deleted worktree's callback `stop()` — its dev-server config is gone. Instead, `finalizeWorktree` may return `{ extra }`, an opaque blob persisted on the registry entry (in `workspaces.json`, which lives in the main worktree and so **outlives** the deleted worktree). On the orphan `prune`/`remove` paths the kernel hands `PurgeContext` (`worktree`, `mainWorktree`, `name`, `extra`) to `config.purgeInfrastructure` (the workspace config — not the dev-server config — is loaded, so the callback is in scope), with `ctx.worktree` pointing at the now-missing dir. A cwd-independent `purgeInfrastructure` tears down by name: deterministic names (containers, volumes) are *derived* from `ctx.name` + the paths, so they need no `extra`; `extra` carries only what can't be re-derived (an external resource id, a random container id). The kernel stays infra-agnostic: it never reads `extra`, only couriers it. Two residual gaps: a consumer that defines no `extra`/`purgeInfrastructure` still leaks (prune prints the generic caveat then), and the side-effect-free `list` auto-prune purges nothing — consumers cover that by making `finalizeWorktree` idempotent against leftover infra (force-remove the container named after the workspace before `docker compose up`).

## Rendering `--guide`

`workspace --guide` prints `templates/guide.md`, expanded by [`guide.ts`](../packages/workspace/src/guide.ts). The prose lives in the template; the command blocks stay in code, so their `#` comments align whatever the package-manager prefix costs (`npm run workspace -- ` against `pnpm workspace `).

Two config-driven flags gate the template: `DEV` (a `devServerScript` is declared) and `PORTS` (a `ports` group is declared). `{{#NAME}}…{{/NAME}}` keeps a block when the flag is on, `{{^NAME}}…{{/NAME}}` when it is off. Markers own their line and one regex handles both forms, so a stripped block leaves no stray blank line. A setup-only project therefore reads a guide with no dev-server section and a workspace definition that mentions only symlinks and config files.

