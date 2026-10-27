---
title: Upgrading Multi-Stack Workspaces
summary: Agent runbook for the clean break from JavaScript wrappers and legacy configuration to the AlignFirst workspace CLI.
read_when:
  - upgrading a consumer with .alignfirst.json or workspace wrappers
  - converting old workspace registries or port slots
  - coordinating worktree cleanup before the multi-stack cutover
---

# Upgrading Multi-Stack Workspaces

This is a manual, coordinated conversion. Do not install a new CLI over unaccounted old runtime state. No compatibility loader, automatic migration or bulk consumer-edit utility is provided. Work on one approved repository and its participating worktrees at a time. Keep external repositories and the user's companion registry unchanged without explicit authorization.

## 1. Inventory before mutation

Record the installed runtime/CLI and wrapper versions, main path, `git worktree list --porcelain`, exact paths, branches, locks, dirty files, missing targets and workspace/dev registry entries. Include externally created worktrees and registered orphans. Save old configuration, wrappers and registry bytes outside removable targets, with appropriate access controls.

Check every worktree for pending finalizers, live spawn PIDs/process groups, command-managed services, containers, volumes, databases, tunnels and name-keyed sidecars. Dead PIDs do not prove external resources are gone. Stop new lifecycle operations during the cutover. Wait for pending finalizers or resolve abandoned ownership explicitly before cleanup.

Agree which data to preserve and where it is backed up. Obtain approval before destructive teardown, volume deletion or worktree removal. External owners retain Git deletion; preserve Paseo archive-before-removal ordering. Do not use force to bypass locks, shared-target protection or failed cleanup.

## 2. Clean resources with the old installation

While each old recipe and its dependencies still exist, stop services through that worktree's old tooling. Execute approved purge/teardown for every registered identity, including failed/partial and orphan preparations. Preserve required databases/volumes first. Inspect resources by explicit project names/labels and durable sidecars; record successful cleanup and anything intentionally retained.

Resolve cleanup failures before retiring recipes. For missing targets, use surviving scripts capable of selecting the recorded name from main, or restore the recipe in a safe existing directory. Do not guess a resource name from a colliding basename. Never delete a registry instead of cleaning its resources.

## 3. Convert settings and project scripts

Rename `.alignfirst.json` to `alignfirst.json` or `alignfirst.jsonc`. Both require `schemaVersion: 1`; only JSONC accepts comments/trailing commas. Preserve `ticketIdPattern`, `plans.repositoryFolder`, `plans.autoArchive` and recognized Git settings. Rename `plans.folder` to `plans.repositoryFolder`. Remove `cli` and project `portRange`; unknown properties now fail rather than warn.

With approval, change only the selected companion entry's `items[".alignfirst.json"]` key to `items.alignfirst`, preserving its selection, unrelated items, profiles and entries. Select the logical family first, then its extension; do not leave both variants in one location. A missing family has a canonical `.json` destination. Companions cannot provide workspace recipes or runtime storage.

Create branch-local `alignfirst-workspace.json` or `.jsonc`, with independent `schemaVersion: 1`. Extract wrapper callbacks into project-owned commands/scripts using [the script ABI](../skills/alignfirst-setup-guide/references/workspace-setup.md#script-abi). Move workspace preparation, file entries, finalize and purge into `workspace`; move infrastructure setup, run files, input selection and servers into `devServer`. Replace callbacks with command services and explicit log-ready spawn descriptors. A managed environment needs a spawn service. Remove unused wrapper/package dependencies only after their behavior is represented.

Move the allocation range and named-port declarations to `devServer.ports`, the sole project range source. Old slot ranges require an explicit agent conversion based on the recorded resources and required pins; no slot migration command remains. `aligndev project free-ports` is a lookup, not a reservation. Preserve main pins and dedicated ranges where external bookmarks, providers or allowlists require them. Run inventory doctor after conversion.

Use argv for data-bearing arguments and quoted ABI variables in shell source. Do not interpolate branch/path text into shell source. Use pure idempotent stdin/stdout transforms for structured files, conditional deletion and URL preservation. Declare computed or environment run-file inputs; never fingerprint secrets. Port values are available only in dev phases. Test each script's nonzero/signal behavior and propagate failures. Purge must cover participating resource families from main for missing targets.

## 4. Prepare the baseline and account for state

Prepare usable effective plans before setup. Project-local plans must exist, be ignored and be untracked by the product repository. Companion plans resolve directly; preserve selection and old history without unsolicited copying. Linked worktrees must use main's effective target and location. Add an ignored, untracked `.local-wt/` destination in every worktree. Local Git exclusions are allowed with approval but still change Git metadata. Preserve tracked `.local` branch-locally.

The new workspace registry is `{ version: 3, workspaces }`, with required recipe provenance per entry. Dev storage is `{ version: 1, servers }`, with retryable `cleanupPending` state. Old/malformed/unsupported registries and surviving slot state are rejected before writes.

Only after every old identity's processes and resources are accounted for may the agent explicitly convert or reset its runtime state. Preserve the old bytes and the resource accounting. A reset is appropriate only when no resource or pending-finalizer ownership depends on that state. Never relabel unknown provenance as defaults, discard failed cleanup or lose live identities to make validation pass. If retained resources require conversion, review the exact new records against the production validator and verify each recorded identity/path/port. Future schema converters are a separate compatibility feature, not this initial conversion.

## 5. Cut over commands and instructions

Update every participating branch's scripts, guides, hooks and automation to `npx -y alignfirst workspace` and `npx -y alignfirst dev`, or explicit Bun forms `bunx --bun alignfirst`. Remove `aligndev worktree` invocations and wrapper bootstrap paths. Use the selected installed CLI for all children; never invoke a different published kernel during acceptance.

`workspace setup` adopts the current exact Git root. `setup <branch>` reuses a branch; `setup -c <branch> --from <ref> --path <path>` creates at an explicit destination. Ordinary setup waits; detached setup requires `wait`. `dev setup` reconciles ports/files/infrastructure; `dev` or `dev up` starts declared services. Manifest-free setup is protocol-ready and performs no install/build/start.

External owners run teardown before deletion. `dev down` stops; `workspace teardown` purges and releases state without deleting files; `remove` additionally deletes the protected Git worktree while retaining its branch. Listing is read-only and retains orphan identities for explicit prune/teardown.

## 6. Validate and recover safely

Use a disposable home/repository first. Validate both families with the production `config --json` reader, read the effective `workspace --guide`, then exercise main and linked setup, file reconciliation, service readiness, stop, purge and retry. Test orphan cleanup from main before relying on it. Confirm unrelated edits, shared plans, companion selections and branches survive cleanup. Record exact checks and separately unverified deployment/native-agent/model behavior.

On failure, retain files, registry identity, ports and resource evidence. Repair the named configuration/script/path, then retry the exact operation; failed cleanup must finish before setup/start. A registered manifest-backed workspace whose manifest disappears cannot become defaults. Restore its recipe or provide the required main orphan purge. Restore the old CLI/config/state only as a coordinated rollback, after checking which new resources have been created. Do not run mixed old/new writers against the same registries.
