---
title: Workspace Package Architecture
summary: Internals of the `@paleo/workspace` kernel — foreground self-exit, stop/teardown signal mechanics, cross-worktree callback dispatch, the `workspace remove` re-exec, the concurrency-cap race, and registry liveness. Complements the workspace setup blueprint (`skills/alignfirst-setup-guide/references/workspace-setup.md`), the consumer-facing guide.
read_when:
  - onboarding to the @paleo/workspace codebase
  - changing dev-server start/stop, foreground, or eviction behavior
  - debugging an orphaned process, a leaked container, or a registry inconsistency
  - touching cross-worktree stop or `workspace remove`
---

# Workspace Package Architecture

For the consumer-facing blueprint — concepts, config fields, the CLI surface, and how to adapt the system to a repository — see the [workspace setup blueprint](../skills/alignfirst-setup-guide/references/workspace-setup.md). This document covers package internals and edge-case behavior that don't belong in that guide.

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

`workspace remove` shells out to `node <devServerScript> down` with `cwd: <target worktree>` rather than stopping the dev-server in-process. This is structural: the `workspace` script doesn't import the dev-server config, so it cannot dispatch callbacks itself. Delegating to the target's own `dev-server.mjs` is how the kernel reaches the callbacks defined on the target's branch. Only after that does `remove` run `purgeInfrastructure` (e.g. `docker compose down -v`), free the slot, and `git worktree remove --force`. Before any of these teardown steps, `remove` refuses when the worktree has uncommitted changes, unless `--force` is passed.

## Concurrency-cap TOCTOU race

The cap check and the subsequent register in `enforceCap` are not atomic. Two concurrent `dev up --evict` from different worktrees can both pass the check and both register, leaving `devLimit + 1` live servers. This is accepted: the window is narrow and the consequence is bounded to one extra server. Resolve manually with `dev list` + `dev down`.

## Registry liveness

An entry in `dev-servers.json` is **live** when at least one of its spawn PIDs is alive; dead entries are pruned on every read. Liveness is purely PID-based on spawn servers — it knows nothing about callback-managed infrastructure. So if a user kills the spawn processes manually instead of running `dev down`, the entry is pruned but the callback `stop()` never fires and infrastructure (e.g. a Docker stack) is orphaned. Always stop via `dev down`.

## Self-healing orphaned workspaces

A workspace becomes **orphaned** when its worktree directory is deleted out-of-band — a manual `rm -rf`, a bare `git worktree remove`, never going through `workspace remove`. Three pieces of state then go stale: the `slots.json` entry (points at a missing path), a possible `dev-servers.json` entry (its detached spawn PIDs can outlive the deleted `cwd`, and PID-based liveness keeps it "live"), and git's own `.git/worktrees/<name>` admin files.

Healing splits by destructiveness:

- **Automatic (safe bookkeeping).** `workspace list` drops the `slots.json` (and matching `dev-servers.json`) entry for any orphan with **no live dev-server PIDs** — same harmless pruning as the existing dead-PID sweep. It runs **no** teardown (no `stopProcessGroup`, no `purgeInfrastructure`): `list` stays free of process- and infrastructure-side effects. Orphans whose dev-server is still running are left in place and surfaced with a `workspace prune` hint.
- **Explicit (active heal).** `workspace prune` stops every orphan's live spawn PIDs (`stopProcessGroup`), runs `purgeInfrastructure` for each (see below), drops both registry entries, then runs `git worktree prune` to clear git's stale admin files.

`workspace remove` against an already-deleted worktree dir takes the same direct-kill path (shared `stopOrphanedDevServer` helper): it can't shell out to `node <devServerScript> down` (the worktree and its `dev-server.mjs` are gone), so it kills the recorded spawn PIDs, runs `purgeInfrastructure`, drops both registry entries, and runs `git worktree prune` — same full cleanup as `workspace prune`.

**Tearing down an orphan's infrastructure (`extra`).** The kernel still can't run a deleted worktree's callback `stop()` — its dev-server config is gone. Instead, `finalizeWorktree` may return `{ extra }`, an opaque blob persisted on the slot entry (in `slots.json`, which lives in the main worktree and so **outlives** the deleted worktree). On the orphan `prune`/`remove` paths the kernel hands `PurgeContext` (`worktree`, `mainWorktree`, `slot`, `extra`) to `config.purgeInfrastructure` (the workspace config — not the dev-server config — is loaded, so the callback is in scope), with `ctx.worktree` pointing at the now-missing dir. A cwd-independent `purgeInfrastructure` tears down by name: deterministic names (containers, volumes) are *derived* from `slot` + the paths, so they need no `extra`; `extra` carries only what can't be re-derived (an external resource id, a random container id). The kernel stays infra-agnostic: it never reads `extra`, only couriers it. Two residual gaps: a consumer that defines no `extra`/`purgeInfrastructure` still leaks (prune prints the generic caveat then), and the side-effect-free `list` auto-prune purges nothing — consumers cover that by making `finalizeWorktree` idempotent against leftover infra (force-remove the stale slot-named container before `docker compose up`).

