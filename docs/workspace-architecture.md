---
title: Workspace Package Architecture
summary: Kernel internals for workspace preparation, cancellation, startup ownership, target-local cleanup, registries and port allocation.
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

## Configuration and host ownership

`alignfirst workspace` and `alignfirst dev` own the public command surface. AlignDev delegates to these commands; consumer JavaScript wrappers and its separate worktree engine are retired. The TypeScript kernel is language-neutral: project-owned commands keep their toolchain, cwd and env. See [the clean-break runbook](upgrading-multi-stack-workspaces.md) before converting old consumers or runtime state.

AlignFirst selects and validates one merged `alignfirst.json` or `.jsonc` from project or companion. It rejects ambiguity, unknown properties, unsupported schema majors and invalid recognized values without fallback. Strict JSON differs from JSONC only in syntax. `@alignfirst/workspace/config` retains generic parsing/schema helpers, recipe types and `validateWorkspaceSettings(settings, label)` semantic validation; it discovers no project configuration. One packaged AlignFirst schema covers `schemaVersion: 1`, nested `conventions`, `plans`, `developerInstructions`, `workspace` and `devServer`. Reads never rewrite committed files.

`alignfirst config --json` returns the full authored configuration and selected workspace location/schemaVersion/portRange/hasDevServer plus absolute registry/runtime addresses. Commands and literal settings are visible; inherited environment values are not read. An absent configuration reports canonical `.json` destination, null schema/range and false capability. A conventions-only configuration retains schema version 1 and default preparation. Project conventions no longer duplicate the range or guard CLI versions.

`preparation.ts` validates effective plans and selected runtime destinations before Git creation. Project placement requires ignored, untracked `.local-wt/`. Companion placement uses external storage directly, with no checkout runtime directory, registry link or runtime ignore rule. The AlignFirst host supplies plans resolution and shared-target protection directly. Project-local effective plans must exist and be ignored/untracked by the product repository; companion plans resolve directly. Linked parity is checked after preparation. Setup never provisions plans, changes companion selection or edits tracked ignore rules. Generated sharing exclusions do not conceal tracked/conflicting data. Usable untracked `.local` is optional default sharing; tracked `.local` stays branch-local. Explicit shared dirs cannot overlap mandatory plans/runtime storage.

Main can be adopted before its initial commit. Preparation checks the index even without `HEAD`, protecting staged plans/runtime paths, shared sources and generated-file destinations. Invalid Git state fails closed. Creating a linked worktree requires a resolvable commit.

An absent manifest has the same baseline and synchronous preparation, with no empty finalizer, install/build, seeded application files, ports or services. Its `ready` state means protocol-ready. `--full` and dev startup require declared managed services. Listing/help/cleanup do not require plans readiness, but configuration and deletion safety still validate. The read-only inventory unions exact normalized Git paths, workspace registrations and external runtime owners. Each row includes nullable `runtimeDir` and `runtimeState` (`active`, `retained` or `deletionPending`). Runtime-only rows have null names/recipes, empty ports and unprepared status. Retained storage does not establish readiness or a live dev environment.

## Invocation and runtime

The kernel receives a `WorkspaceOperation`: cwd, environment, output channels, optional public command forms, and an `InstalledCliInvocation` containing the absolute runtime executable and installed AlignFirst bin path. `runWorkspace` also receives a parsed command and verbosity; `runDevServer` receives a parsed dev command. Neither reads `process.argv` or configures mutable command state. The outer CLI owns error presentation, exit codes, structured results and SIGINT/SIGTERM cancellation for workspace and non-foreground dev operations. Foreground handlers distinguish startup rollback, owned shutdown and non-owning detach. Cancellation propagates through hooks, command children, readiness waits and file generation. It awaits owned command termination, prevents later steps and retains incomplete cleanup for explicit retry. Startup rollback uses a fresh cleanup lifetime.

`invocation.ts` uses `@alignfirst/docmap/invocation` for public command hints. Internal dispatch uses the exact installed runtime/bin plus fixed argv: `workspace __finalize`, `dev setup`, `dev down`, or `workspace remove <path>`. Workspace cleanup adds the internal `dev down --retain-cleanup` flag so successful stopping retains the dev record through purge. It never performs a new package-runner lookup or forwards loaded callbacks. Children run in the requested target cwd and load its current recipe through CLI dispatch. Removal of the current worktree re-executes from main before cleanup or deletion.

`WorkspaceOutput` separates text, diagnostics and raw progress writes from the host's JSON result channel. JSON hosts route all three to stderr. Manifest adapters accept the same output and environment explicitly; command children and setup-log followers use those channels. `WorkspaceHost` provides narrow work-files validation and shared-directory protection callbacks for the host lifecycle, without a reverse package dependency or recursive `alignfirst config` calls.

## Manifest execution seam

`manifest-adapter.ts` exposes `adaptWorkspaceManifest(settings, { mainWorktree, recipe, configurationDir?, companionDir?, storage?, signal?, env?, output? })`. It accepts validated recipe sections without an independent schema version and returns workspace hooks plus an optional dev config. `WorkspaceHost.loadWorkspace(worktree)` supplies target-selected `WorkspaceConfig`: recipe provenance, authored sections in `settings`, optional `configurationDir`/`companionDir` and resolved `storage`. Target commands still execute in their checkout. Existing targets use their own selection; missing manifest-backed targets require main's same-source purge recipe. Source changes fail before hooks; extension-only changes remain valid.

`script-context.ts` constructs phase-limited `ALIGNFIRST_WORKSPACE_CONTEXT`, scalar environment conveniences and single-pass interpolation. Every phase carries target-specific absolute `runtimeDir`; selected existing configuration supplies `configurationDir`, and a configured companion supplies `companionDir` even before its directory exists. These paths are scalar references, without environment aliases. Context construction resolves each target independently, including orphan purge using main's configuration and cwd but the missing target's runtime. Both old and current JSON ABI names are stripped from inherited environments and reserved against authored overrides; only the current name is emitted. `resolveCommand` keeps shell source literal and resolves argv, cwd and declared env. `command-executor.ts` streams lifecycle stdout or captures data stdout, supplies transform stdin, and awaits process close/output draining. Cancellation stops its detached process group before rejecting. Hooks accept an invocation `AbortSignal`; an explicit hook signal overrides the adapter's default, allowing rollback to use a fresh cleanup lifetime.

`resolveServers` runs after `runDevSetup`. Its resolved descriptors carry command/args, cwd, env, port and readiness detectors through conflict checking, spawning and summaries. Service logs remain under the worktree runtime directory, regardless of package cwd; labels are URI-encoded in filenames. Manifest log regexes have no stateful flags. Optional `error: { preset: "node", log?: "custom regex" }` combines `detectCommonJsError` with the custom expression using OR semantics and preserves the matched marker. Custom-only errors remain supported; omitting `error` installs no log detector. The preset is a startup heuristic, not complete failure detection; framework markers remain project-owned.

## Setup modes

`workspace setup` synchronously creates or adopts a Git worktree, then runs `finalizeWorkspace` (install, build) in a **detached child** that streams to `<runtimeDir>/logs/workspace-setup.log`. Ordinary setup waits for the child.

The child is spawned as `workspace __finalize` with no target argument and `cwd` set to the target worktree. It re-detects the Git root and resolves its existing registry entry by normalized absolute path, retaining any collision suffix. `--force`, `--full`, `--verbose` and an internal `--preparation-token` are forwarded. Registration atomically publishes the recipe, parent PID/token and external runtime generation before mutable preparation. The child adopts that token with its own PID before validation, logs or hooks. Missing or invalidated tokens fail before effects. Only the matching owner can settle or release preparation; live ownership never expires by age. With no finalize steps, preparation marks the entry ready synchronously and spawns no empty child. Detached `--full` may still dispatch a child for dev setup.

- **Blocking (default).** After spawning the child, `runSetup` calls `waitForWorkspace`, which polls `workspaces.json` until the finalize child marks the workspace `ready` or `failed`. During the wait it shows a ticker: a single status line `Finalizing… <label> (<elapsed>) — tail: <log>`, rewritten in place on a TTY and re-emitted on label change otherwise. `--verbose` replaces the ticker with a live follow of the setup log from its current size (the pre-finalize lines were already printed); on settle, one final drain read prints the log bytes written since the last poll.
- **Detached (`-d`/`--detached`).** `runSetup` returns right after spawning the child, printing `Setup continuing in background.` plus a `wait` hint. The caller joins later with `workspace wait`, which runs the same ticker; its `--verbose` first replays the last 30 log lines, since the joiner saw no history. `--enter` enters the worktree immediately in this mode (it already exists), while finalize keeps running.

Cancelling a setup waiter stops its wait, not the detached finalizer. Once spawned, that child has an independent cancellation lifetime and continues updating the registry and log. The same applies to standalone `workspace wait`.

### Failure before the finalize spawn

`registerWorkspace` publishes preparation ownership before shared links, runtime files or hooks can mutate files. An error in preparation, `preSetup`, seeding, summary or child launch settles the matching pending entry as failed and clears its live claim. When a setup log exists, the failure is appended there. Cleanup retains the registered recipe and runtime generation. A `failed` entry passes the pending check, so the retry after any setup failure is a plain `setup`. A `ready` entry keeps its status: an already-finalized main worktree whose `preSetup` refuses stays usable and is not re-finalized. `copyAndPatchFile` throws a `WorkspaceError` on a missing required source or a non-idempotent patch for the same reason: a `process.exit` there would skip the catch.

### `--full`

`setup --full` adds the dev step. It is refused up front when the manifest declares no managed dev services.

After `finalizeWorkspace` succeeds, the finalize child reports the progress label `Dev setup` and dispatches `dev setup --from-finalize --preparation-token <token>` through the installed CLI in the worktree, its output in the setup log. Admission verifies the matching live preparation owner under the shared lock. That claim protects the dev step without a competing startup claim and permits its still-`pending` entry. Missing, mismatched, dead or invalidated ownership fails before effects.

The child then marks the workspace `ready` whatever the outcome. `ready` means the workspace's own setup succeeded; the dev side is tracked by `devSetupAt` and `devSetupFailure`, and the next `dev setup` or start retries it. The dev-server records its own failures. When it exits non-zero without a record newer than the step's start (it could not run, or stopped at its readiness check or earlier), the child records `dev setup exited with code <n>`.

The blocking `setup --full` and the standalone `wait` report a `ready` entry with a `devSetupFailure` as ``Workspace ready; dev setup failed: <message>. Run `dev setup` to retry.``, and exit 1. `registerWorkspace` drops the `devSetupFailure` of an earlier run, so `wait` reports only the current setup's dev failure.

On a workspace already `ready`, the finalize child skips, so no dev step runs there. The calling process runs it after the wait instead, in the foreground with inherited stdio and without `--from-finalize`, and records a failure the same way.

### Progress file

The blocking ticker cannot call into the detached child, so they communicate through a file: `<runtimeDir>/logs/workspace-setup.progress`. `FinalizeContext.progress(label)` overwrites it with the current label (and appends `PROGRESS: <label>` to the log); the ticker re-reads it each poll. It is deleted when the log is truncated at the start of `setup` and when finalize settles (ready or failed), so a stale label never leaks into the next run.

### Branch-name conflicts

Git refs are hierarchical: `refs/heads/test` cannot coexist with anything under `refs/heads/test/`. `createBranch` treats a name as **taken** when the exact ref exists (local or `origin/`) **or** a ref exists under its namespace, and refuses with a `WorkspaceError` that names the conflict. `--dedupe` opts into the suffix loop (`test-2`, `test-3`…), preferring a candidate whose branch name and worktree directory are both free so the two stay aligned. An **ancestor** conflict (requesting `test/abc` while branch `test` exists) can never be suffixed away, so it always fails, even with `--dedupe`. The worktree-directory dedupe (`dedupeWorktreePath`) is always on and independent of `--dedupe`.

## Foreground self-exit

A foreground `dev` ([`runForeground`](../packages/workspace/src/dev-server.ts)) runs the same start pipeline as `dev up`, but the servers are spawned **detached** (each in its own process group) and only their **child PIDs** are registered in `dev-servers.json`. The foreground CLI parent itself is never in the registry — so nothing else can find it to signal it.

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

- `dev down` (`stopLocal`) — marks cleanup pending before stopping any PID, stops owned spawn groups and then command services in reverse order, sweeps stale ports and releases the record only on success. Stop failures are collected while remaining services are attempted.
- `dev down --all` (`stopAllRegistered`) — dispatches each target, aggregates failures and releases only successful paths on fresh locked reads. Failed targets remain retryable even after PID exit.
- Eviction (`evictOldest`) — dispatches the oldest live targets by `startedAt`. A required cleanup failure prevents replacement startup.

Startup rollback uses the same local service stopper with a fresh cancellation lifetime. It persists a rollback record before cleanup, including when startup never reached registration. Only successfully started command services are stopped during rollback; a failed start owns its partial effects or leaves them recoverable by purge. Registration and startup-summary failures also roll back. Foreground cancellation waits for this work before exiting; failed stops remain discoverable through `dev list` and `status`.

## Target-owned stop dispatch

`target-stop.ts` owns `stopTarget`. Down-all, eviction and workspace cleanup pass the recorded target identity and installed invocation. A same-target dev dispatch uses `stopLocal`; cross-worktree dispatch launches child-local `dev down` in the victim cwd. The child loads that branch's current manifest, scripts and ports. A defaults-only caller can stop configured victims; no caller callback list crosses the boundary.

Missing or malformed registered manifests fail without default fallback. Changing between `.json` and `.jsonc` is supported. Missing worktree directories cannot host stop children; explicit teardown/prune uses recorded PID fallback and main's orphan purge recipe. No historical executable recipe is stored.

## Shared cleanup and installed-CLI re-exec

`teardown`, `remove` and explicit orphan cleanup share `cleanupTarget`. Cleanup atomically publishes a per-target `cleanupOwner: { pid, token }` and its pending gate under the shared lock, capturing the registration identity and runtime generation. A second live cleaner fails immediately with a cleanup-in-progress diagnostic; unrelated targets remain independent. Live claims never expire by age. Cleanup refuses live preparation/finalizer and startup owners even when the checkout is missing. Explicit cleanup replaces dead cleanup ownership and invalidates old handoff/startup tokens before effects. An unowned pending preparation without a cleanup gate still requires explicit repair; pending status alone does not establish quiescence. Existing targets load their current workspace recipe and dispatch child-local stop independently of the caller's dev capability. Recorded-PID fallback may stop remaining processes after invocation failure, but the failure still propagates and purge/deletion does not report success.

Cleanup invokes the selected recipe's `purgeInfrastructure` with the captured registered name, target path, main path, provenance and verbosity. Existing targets resolve cwd and scripts in the target. Missing manifest-backed targets require main's valid manifest and purge recipe, executing from main with the orphan identity. Defaults-only orphans invent no project commands. Purge runs for failed and partial preparations even without dev setup; `continueOnError` permits later purge attempts while aggregate failure still retains cleanup.

Before stopping a target, `retainCleanupIdentity` rechecks admission and captures cleanup ownership on a fresh locked read. Its independent `cleanupPending` gate survives successful `dev down` and blocks workspace setup, dev setup and startup until workspace cleanup completes stop and purge successfully. Internal retain-cleanup stop children use the parent's gate without claiming workspace cleanup. Child stop and PID fallback retain pending dev records through purge. After failure or cancellation, cleanup awaits owned work and releases only its matching claim, preserving the gate, recipe and retry evidence. Retry remains available after recovering an abandoned pending preparation. Successful cleanup releases dev/workspace entries and ports only after fresh locked checks of the captured registration, PID/token and runtime generation; stale settlement cannot release replacement resources. Companion teardown atomically releases its captured generation to retained runtime. Remove/prune release that same cleaned generation directly to deletionPending, blocking re-adoption without a retained-state gap. Setup and startup refuse pending dev cleanup. Prune attempts other orphans after a failure, but returns nonzero without a success document or Git prune. Listing retains every orphan identity and performs no resource cleanup. No callback or subprocess runs under the registry lock.

`teardown` preserves files, dependencies, seeded/runtime files, shared links and all Git state. Main teardown preserves the shared registry directory and other entries. It accepts dirty worktrees, has no force/all mode, and never runs Git deletion or prune. An already-unregistered verified worktree succeeds without guessed-name purge; a dev-only entry supplies its recorded identity. Unknown names and unrelated same-basename paths fail. Re-adoption runs normal setup again; names and ports are released rather than reserved.

`remove` checks exact Git registration and main/locked/nested/shared-target protection before resource side effects. Protection includes plans, session/companion paths and manifest-declared shared sources. Dirty removal requires `--force`; force bypasses only dirtiness. Git deletion retains the branch, and unprepared worktrees receive no guessed purge identity. After Git succeeds, removal deletes only the verified target runtime. Git failure or cancellation retains deletionPending identity. A filesystem deletion failure remains discoverable outside the removed subtree; retry handles an already absent runtime directory without another purge. Main runtime, shared registry, sibling runtimes and plans are preserved. `dev down` only stops processes and command services; destructive purge belongs to teardown/remove/prune.

## Startup ownership and concurrency cap

`DevServerConfig.resolveStartSettings?: () => DevStartSettings` is a lazy adapter seam returning only numeric `maxConcurrentDevServers`. The adapter resolves authored numbers or `{ env, default }` from the supplied invocation environment. Undefined selects the default; defined values require whole nonnegative safe decimal integers. Zero and omission mean unlimited. Read-only already-running and foreground-attachment decisions precede resolution; a real start/restart resolves before claims, stopping, setup or eviction. Reports retain the authored binding, and cleanup, explicit dev setup and workspace setup (including `--full`) do not evaluate it. No dotenv loading occurs.

`startup-ownership.ts` claims each exact worktree path in `dev-startups.json` (`version: 1`, `owners`) under the shared registry lock before setup, restart, eviction or stale-port cleanup. Each claim records the CLI PID and a unique token. Hooks run outside the lock while the claim remains held. A live PID's claim never expires by age; only a dead holder can be replaced. Publication and rollback verify ownership, and release removes only the matching token.

Preparation publication refuses any existing startup claim under this same lock. Startup publication freshly refuses any preparation claim, closing the gap between explicit dev setup's initial checks and its startup claim. Abandoned opposite-phase ownership requires explicit cleanup; admission never relabels it as a new phase. The startup sidecar's schema and raw persistence live in `startup-registry.ts`, avoiding a dependency cycle between these guards.

Registered dev instances carry that token as `instanceId`. Rollback and cleanup compare captured instance identity so a stale owner cannot overwrite or remove a replacement run.

This exclusivity is per worktree. The cap check and the subsequent register in `enforceCap` are not atomic. Two concurrent `dev up --evict` from different worktrees can both pass the check and both register, leaving `maxConcurrentDevServers + 1` live servers. This is accepted: the window is narrow and the consequence is bounded to one extra server. Resolve manually with `dev list` + `dev down`.

## Registry liveness

An entry in `dev-servers.json` is **live** when at least one spawn PID is alive. `hasLiveSpawnPids`, `liveDevServers` and `liveWorktrees` share that predicate. `pruneDeadServers` and locked `pruneAndPersist` retain entries with `cleanupPending: true` even after all PIDs exit. Retention alone does not count toward the cap; retained entries with live PIDs still count. A pending-cleanup entry blocks a fresh start on that exact path.

Before asynchronous stopping or startup rollback, `markDevServerCleanupPending` reads fresh unpruned state under the shared lock. It can create a rollback record before ordinary startup registration. `completeDevServerCleanup` removes only the requested path after the caller confirms cleanup success; captured `startedAt` and `instanceId` protect a replacement run. Hooks, subprocesses and process waits run outside locks. Stop-all and eviction update individual paths on fresh reads, preserving entries created by child commands.

Ordinary dead records without pending cleanup may still be pruned after manual PID killing; liveness does not discover callback-managed resources. Workspace-orphan identities are retained independently until explicit cleanup.

## Port allocation

`dev setup` ([`dev-setup.ts`](../packages/workspace/src/dev-setup.ts)) runs explicitly, and implicitly before `up`, `restart` and the foreground start. It resolves the workspace, requires the `ready` status, reconciles the ports, writes the run files, then runs `DevServerConfig.setup` when `devSetupAt` is unset or `--force` is given. In the main worktree, it first re-keys a renamed main entry, or creates a `ready` main entry when there is none. That entry carries `neverFinalized: true`, so a later `workspace setup` still finalizes the main worktree. A failure after the readiness check is recorded as `devSetupFailure`; a successful run clears it.

### Reconciliation

`reconcilePorts` ([`ports.ts`](../packages/workspace/src/ports.ts)) is pure. It takes the resolved config, the workspace's stored ports, the ports stored on every other entry, and a probe. Then, in `names` order:

1. In the main worktree, each `declare` entry with a `mainWorktree` takes its pinned port.
2. A stored port is kept when the config still allows it for its name and nothing reserves it. An allowed port is inside the range, not excluded, not a bad port, and inside the name's dedicated range, or outside every dedicated range for a name without one. A port is reserved when it is pinned, already assigned to another name of the workspace, or, in a linked workspace, stored on another entry.
3. Each missing name gets the lowest port of its scope that is allowed for it, neither pinned nor assigned, stored on no other entry, and free according to the probe. The scope is the name's dedicated range, or the project range. Each scope keeps its own cursor, so a rejected port is never probed twice.

An undeclared name is not carried over, so its port is freed. Removing the entire ports declaration stores an empty map. An exhausted scope is a `WorkspaceError` that names the range and points at `workspace remove`. For a dedicated range, it adds that ports held there under other names are freed at those workspaces' next `dev setup`. `--reset-ports` passes no stored port, so every port is allocated again, pins excepted. It refuses first while the worktree's dev-server runs. When the ports change, they are printed as one `Ports: …` line.

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

`seedFiles` ([`file-entries.ts`](../packages/workspace/src/file-entries.ts)) writes both file lists through `copyAndPatchFile`: `workspace setup` the `gitignoredFiles` with a `PatchContext`, `dev setup` the `runFiles` with a `RunFileContext`, which adds `ports`.

Content producers and patches may be asynchronous. Destination checks reject committed or staged paths, Git metadata, the kernel-owned `.local-wt/workspace-registry` subtree and its ancestors or canonical aliases, and logical/canonical escapes. Dev setup preflights destinations before registry mutation; ordinary application sidecars elsewhere in `.local-wt` remain supported. Checks run before generation and again after awaited work, before writing; cancellation is checked before the write. Manifest file lists also reject canonical aliases across lists.

The `existing` policy decides the fate of an existing file. `reseed` writes it again from its source. `patch` re-applies its `patch` and rewrites it only when the result differs. `keep` leaves it. `copyAndPatchFile` refuses a patch that is not idempotent, on a seed as on a re-apply, before writing. The rewritten files are reported in one `Updated <paths>` line, printed even when a later entry fails.

`workspace setup` uses `patch`, and `reseed` with `--force`. `dev setup` never reseeds a run file: a deleted one is created again. An explicit `dev setup` uses `patch`.

Before a start, `dev setup` uses `keep`, so a hand edit survives a restart. It switches to `patch` when the basis of the run files changed: the ports, and the defined values of `DevServerConfig.runFilesInputs`. The workspace entry stores that basis as `runFilesWrittenWith: { ports, inputs }` in `<registryDir>/workspaces.json`, alongside its allocated `ports`.

`runFilesInputs(ctx)` may be asynchronous and runs after port reconciliation. Each defined UTF-8 input value is stored as `sha256:<64 lowercase hex characters>` under its literal key; values are never stored in plaintext. Missing keys remain absent, distinct from an empty string's fingerprint.

The basis is cleared before a write batch and saved after every file succeeds; an entry without one counts as changed, so a failed batch is reconciled at the next start. The `Updated` line then becomes a warning naming the moved ports and the changed input keys, without the input values.

A generated run file, a `content` source without `patch`, would never follow a port move. `writeRunFiles` turns its generated content into its `patch`, so each rewrite regenerates it. Sources are evaluated in entry order, after earlier files have been written.

## Versioned registries and paths

`workspaces.json` stores `{ version: 4, storage, workspaces, runtimeOwners }`. `storage` is `{ in: "project" | "companion", mainWorktree, registryDir }`, with canonical absolute paths. Every workspace entry requires a recipe: `{ kind: "defaults" }` or `{ kind: "manifest", file: "alignfirst.json" | "alignfirst.jsonc", in: "project" | "companion" }`. Optional `preparationOwner: { pid, token }` and `cleanupOwner: { pid, token }` claims protect preparation/finalizer handoff and exclusive stop/purge respectively. Version 3, retired provenance and unsupported state are rejected without conversion.

`runtimeOwners` is empty locally. Companion records are keyed by the resolver's directory ID and store `{ worktree, runtimeDir, main, generation, state, deletionClaim? }`. State is `active`, `retained` or `deletionPending`; a deletion claim holds `{ pid, token }`. Records survive teardown without reserving names or ports. Paths must match the declared layout, and duplicate identities fail. The shared registry owns retry evidence outside the directory being deleted.

`dev-servers.json` retains `{ version: 1, servers }`; `dev-startups.json` retains `{ version: 1, owners }`. Readers validate selected registry ownership and workspace state before interpreting either sidecar. Missing storage is empty only without contradictory sidecars or runtime data. The first locked mutation records ownership before resource effects. Malformed, foreign or obsolete storage fails with resource-accounting guidance. Readers never infer default provenance or repair legacy fields. `portIndex`, `purgeData`, implicit dev-setup repair, duplicate-main repair and surviving `slots.json` state are refused.

Registration and dev setup validate manifest provenance against the current logical family. Changing only its extension is permitted. Removing a registered manifest cannot silently select defaults. Diagnostic workspace reads retain provenance without requiring a present recipe file.

The pure `resolveWorkspaceStorage(selection, target)` resolver in `storage.ts` computes canonical addresses independently for each target. Local addresses retain main's registry and the target's `.local-wt`. Companion addresses use `<companion>/.local-wt/workspace-registry` and `<companion>/.local-wt/worktrees/<readable-basename>-<full-sha256-path-digest>`. It performs no ownership checks or filesystem writes. `runtimeDirForTarget(config, target)` resolves log/progress addresses independently of the caller. Registry file and lock helpers accept absolute shared addresses; main remains an authorization identity.

Local storage requires real directories and regular registry files. A linked worktree's registry directory, when present, must link to its own main's registry. Companion storage addresses the shared registry directly, with no per-runtime registry links. Canonical companion-root aliases are supported; registry files and registry/runtime path components below the trusted root must be real. External owner/main agreement is exact: unexplained relocation requires explicit recovery. Local physical ownership still permits the main relocation described below.

`runtime-ownership.ts` provides claim/re-adoption, atomic resource release, disposal claims and deletion. `claimRuntime` publishes an active generation before writes; re-adopting retained storage changes that generation. `releaseRuntimeResources(storage, generation, mode, cleanup?)` verifies captured cleanup ownership when releasing a workspace entry, then releases resources and publishes either retained state or deletionPending in one mutation. Runtime-only release requires no workspace claim. Remove/prune must choose deletionPending directly, then dispose only after their Git/resource checks. A pending deletion blocks setup/start. Live preparation, startup, dev resources or another deletion claim block disposal.

`disposeRuntime` validates the exact path, generation and PID/token claim before recursive deletion outside the registry lock. It removes only the owned runtime directory, then clears its record on a fresh matching write. Missing directories succeed on retry. Failure or cancellation preserves deletionPending and releases only the caller's claim; live claims never expire by age. `inspectKnownWorkspaceState` reports selected-registry cleanup requirements without mutation. Clean retained files are not live resources. No placement-history database exists.

Lifecycle admissions recheck the companion registration while holding the short selected-runtime lock. `claimRuntimeDisposal(storage, generation, admit?)` also runs the host admission callback under that lock before publishing deletion ownership. Both removal claims and changed selection block runtime-only prune, including after unregister's clean-state inspection. Already-pending disposal remains retryable once the removal gate is released. CLI companion removal first publishes a PID/token removal claim in the companion registry, then inspects selected runtime under that runtime lock. Companion-registry and runtime locks are never nested; no lock spans hooks, Git deletion or recursive filesystem removal. Clean retained files permit unregister, which reports their absolute paths and the loss of automatic discovery. Active/failed resources and pending disposal refuse unregister, including force. Manual selection edits can hide old arbitrary storage; cleanup under the old selection is required before changing it.

Both registries store normalized absolute paths. Keys are opaque registered names: `registerWorkspace` first reuses an exact path match, otherwise allocates the basename or appends a SHA-256 path prefix (initially eight hex characters). It extends the digest, then uses numeric discriminators if necessary, under the insertion lock. Assigned suffixes remain stable when collisions disappear. Main dev setup and dev-only cleanup identity recovery retain recipe provenance.

Selectors resolve exact normalized paths before exact registered names, with no basename-search fallback. Git discovers the current root even from nested cwd. Independent clones have independent registries; there is no machine-wide uniqueness promise.

### Main relocation and re-key

A `main: true` entry follows the current main-worktree path in memory. Linked paths, including missing external paths, stay unchanged. The loader retains the main entry's original absolute path as rename evidence. A changed basename is a genuine rename; a parent-only relocation preserves an unchanged suffixed identity.

`updateWorkspaces` reconciles a genuine rename before mutation, allocating a nonconflicting name rather than overwriting a linked entry. It preserves creation time, preparation, ports and provenance. Only a changed registered name invalidates `devSetupAt` and `runFilesWrittenWith`, and warns that old-named resources are not reused. Read-only loading persists nothing. Status/deletion writes resolve by path again so a captured key cannot target a replacement entry.

### Registry lock

`updateWorkspaces` and `updateDevServers` serialize read-modify-write operations through the same `<registryDir>/workspaces.lock` ([`registry-lock.ts`](../packages/workspace/src/registry-lock.ts)). They read fresh state after acquiring it. Callers never nest these locks.

- The lock file is created with `O_EXCL` and holds `<pid>:<token>`, a token unique to the holder. The `finally` deletes it only while it still holds that token.
- A lock is stale when its PID is dead or the file is older than 30 seconds. A file without a PID yet is judged by its age only. A waiter renames a stale lock to a unique name before deleting it, so only one waiter replaces it. A rename that caught a fresh lock, told apart by its content, puts it back. A third process that creates a lock during that window overlaps the restored holder; closing it would need OS-level locks.
- A waiter retries every 50 ms and fails after 10 seconds, with an error naming the lock file.

The lock covers only registry JSON and the listen probes of port allocation. It never spans a hook, Git operation, child dispatch or process wait. Cleanup claims an identity, releases the lock for side effects, then verifies its PID/token and captured registration on fresh locked settlement. Read-only lookups take no lock. Both writers use `registry-storage.ts` to write a unique temporary file beside the registry and rename it atomically; unlocked readers never see partial JSON.

## Self-healing orphaned workspaces

A workspace becomes **orphaned** when its worktree directory is deleted out-of-band — a manual `rm -rf`, a bare `git worktree remove`, never going through `workspace remove`. Three pieces of state then go stale: the `workspaces.json` entry (points at a missing path), a possible `dev-servers.json` entry (its detached spawn PIDs can outlive the deleted `cwd`, and PID-based liveness keeps it "live"), and git's own `.git/worktrees/<name>` admin files.

`findOrphanNames` retains the registry key after its directory disappears. `workspace list` preserves every orphan identity, regardless of PIDs, preparation status or recorded failure, and prints an explicit-cleanup hint. It performs no teardown and writes no workspace registry. `workspace prune` explicitly stops recorded processes, purges infrastructure, disposes cleaned runtime and prunes Git's stale admin files. It also finds runtime-only orphans after teardown followed by external Git deletion. Those owners are disposed without inventing a resource name or calling purge again. A fresh path check refuses disposal when the checkout reappears. Failures are aggregated while other eligible orphans continue; any failure suppresses the success JSON document and Git prune.

`workspace remove` against a deleted directory uses the same recorded-PID fallback as prune. A missing target cannot host an ordinary `dev down` child.

**Tearing down an orphan's infrastructure.** Invoke cleanup from surviving main so its purge recipe can execute with the missing target's identity. `PurgeContext` carries `worktree`, `mainWorktree`, `name`, `recipe`, `verbose` and an optional signal. The script ABI preserves the missing target path while the adapter uses main as execution base. Orphan teardown leaves Git's stale registration for the external owner; explicit prune can clear it later.

The hook tears down by name. The consumer's `DevServerConfig.setup` names every resource after the workspace, and records a resource with only a random id in a file named after the workspace, under the main worktree. No teardown state is stored in the registry, so a partial `setup` is torn down like a complete one, and the hook runs whether or not `dev setup` ever succeeded.

A missing purge recipe cannot discover external resources by itself. Cleanup hooks must be idempotent and propagate failure; PID stopping alone does not establish infrastructure cleanup.

## Rendering `--guide`

`workspace --guide` prints `templates/guide.md`, expanded by [`guide.ts`](../packages/workspace/src/guide.ts). The prose lives in the template; code aligns command comments for the host's rendered public command forms.

One manifest-backed capability gates the template: `DEV`, on when managed dev services are declared. `{{#DEV}}…{{/DEV}}` keeps a block when the flag is on, `{{^DEV}}…{{/DEV}}` when it is off. Markers own their line and one regex handles both forms, so a stripped block leaves no stray blank line. A setup-only or manifest-free project reads a guide without a dev-server section. It states baseline preparation, effective capabilities and direct CLI forms; default readiness never implies dependency/application readiness. Without a custom workspace summary, setup and status report the registered name, path, branch and preparation status. External owners adopt in place and run teardown before their own Git deletion.
