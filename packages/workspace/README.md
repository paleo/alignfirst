# @alignfirst/workspace

The TypeScript kernel behind `alignfirst workspace` and `alignfirst dev`. It prepares isolated Git worktrees and optionally manages named ports, run files, project commands and dev services. Consumers use the AlignFirst CLI; they need no JavaScript wrapper, local kernel dependency or `package.json`.

## Use

```sh
npx -y alignfirst workspace --guide
npx -y alignfirst workspace setup -c feat/42 --from main
npx -y alignfirst workspace list --json
npx -y alignfirst dev setup
npx -y alignfirst dev
npx -y alignfirst dev down
npx -y alignfirst workspace teardown
npx -y alignfirst workspace remove ../project-feat-42
```

For explicit Bun execution use `bunx --bun alignfirst`. Ordinary `bunx` may honor the Node bin shebang. The kernel runtime does not change project command toolchains. Python monorepos, Rust and Node projects use the same manifest and script ABI, including per-command cwd/env.

## Baseline and manifest

Before setup, prepare usable effective plans, untracked by the product repository, and ignored/untracked `.local-wt/` runtime storage. Project-local plans must exist and be ignored; companion plans resolve directly. Linked worktrees share main's effective plans and usable untracked `.local` when present. Tracked `.local` remains branch-local. Setup never provisions missing plans or changes companion selection.

Without a manifest, readiness is synchronous and protocol-ready. No install/build, application seeding, ports or services are implied. `--full` and dev startup require declared services.

Project behavior belongs in branch-local `alignfirst-workspace.json` or `.jsonc`, with `schemaVersion: 1`. JSON is strict; JSONC allows comments/trailing commas. Ambiguous extensions, unknown properties and unsupported schemas fail without fallback. The independent project-conventions family is `alignfirst.json`/`.jsonc`; companions may select that family, never workspace recipes. The sole project range is `devServer.ports`.

Commands/scripts own stack-specific preparation, pure idempotent transformations, summaries and cleanup. `ALIGNFIRST_CONTEXT` supplies phase-limited JSON while stdin remains available for transformations. Spawn services use log-regex readiness; command services own their readiness. Managed environments require a spawn process. See the [setup reference](https://github.com/paleo/alignfirst/blob/main/skills/alignfirst-setup-guide/references/workspace-setup.md) for the complete manifest, interpolation restrictions, Python examples and ABI.

## Ownership and recovery

External tools run setup inside their checkout, then teardown before their own deletion. `dev down` stops; teardown also purges and releases identity/ports while retaining files and Git state. Remove adds protected Git deletion and preserves branches. Listing retains orphan identities; explicit prune cleans resources before retiring them.

Existing targets use their current recipe. Missing manifest-backed targets require main's purge recipe, selecting resources by recorded name/labels or durable sidecars. Failed stop/purge retains retry state after PIDs exit and prevents replacement startup. Force never bypasses protected paths or failed cleanup.

Workspace storage is version 3 with required recipe provenance; dev storage is version 1. Old/unknown state is rejected before mutation. Existing wrappers, settings or slot registries require [the clean-break upgrade runbook](https://github.com/paleo/alignfirst/blob/main/docs/upgrading-multi-stack-workspaces.md), including all-worktree resource accounting. Never delete registry files instead of cleaning resources.

Both new configuration families have independent schema majors and packaged JSON Schemas. Future breaking majors use sequential in-memory conversion retained through the CLI major, without rewriting committed files. This initial release supplies no converter for retired wrappers/settings.

For kernel internals and accepted limitations, see [Workspace Architecture](https://github.com/paleo/alignfirst/blob/main/docs/workspace-architecture.md).
