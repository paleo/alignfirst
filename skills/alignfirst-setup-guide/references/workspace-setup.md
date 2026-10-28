# Set Up Multi-Stack Workspaces

Use `npx -y alignfirst workspace` on Node or `bunx --bun alignfirst workspace` on Bun. Git is required. Project commands keep their own toolchain; Python, Rust and non-Node repositories need no `package.json`, JavaScript wrapper or local workspace dependency. Ordinary `bunx` may honor the bin's Node shebang; use `--bun` for explicit Bun execution.

Workspace can be adopted independently of protocols, skills and Docmap. Existing installations with `.alignfirst.json`, wrappers or old registries first follow [the clean-break upgrade runbook](upgrading-multi-stack-workspaces.md). Do not run new commands against unaccounted old resource state.

## Implementation process

1. Inspect the repository from a clean working tree. Identify work files, ignored data, runtime requirements, install/build/test commands, file templates, ports, service readiness logs and resource ownership.
2. Present the proposed preparation, service and destructive cleanup procedures. Obtain approval before changes.
3. Prepare effective work files and runtime exclusions before setup. Add a manifest only for project-specific behavior.
4. Validate with `npx -y alignfirst config --json` and read `npx -y alignfirst workspace --guide`.
5. With authorization, commit the scaffolding before creating a disposable linked worktree so it contains the manifest and project scripts. Exercise setup, dev when declared, stop and cleanup. Preserve user branches and shared data. Do not push unless separately authorized.

## Required baseline and defaults

Setup requires usable effective `.plans`, untracked by the product repository. Project-local plans must exist and be ignored. A symlink into a separate work-files repository is supported. Companion plans resolve directly; no project-local link is needed. Linked worktrees must resolve to the main worktree's effective plans target and selection.

Main can be adopted before its initial commit. Staged plans/runtime paths, shared sources and generated-file destinations remain protected. Make an initial commit before creating a linked workspace; commit templates before relying on committed-source recipes.

Project placement uses per-worktree `.local-wt/`, ignored, untracked and free of conflicting files or symlinks. Setup creates it when absent. Its kernel-owned `workspace-registry/` subtree is local to main; linked worktrees link only to their own main's registry. Effective companion `workspaceRuntime` placement instead uses `<companion>/.local-wt/workspace-registry` and a separate path-derived directory below `<companion>/.local-wt/worktrees/` for each real worktree. It creates no checkout runtime placeholder, registry link or runtime ignore rule. Preserve and repair conflicting or redirected registry state before retrying. Use tracked `.gitignore` rules with approval, or root-anchored rules in `git rev-parse --git-path info/exclude` when project files must stay unchanged. Local exclusions still change Git metadata; companion placement does not suppress explicit shared-directory links, project hooks, generated application files or Git operations.

Setup never provisions missing plans, selects companions or edits tracked ignore rules. Prepare these separately through [plans setup](plans-setup.md) or [companion setup](companion-setup.md). For an assistant, the separately authorized `aligndev guide work-files-setup` procedure precedes ticket reservation, request capture and coding effects.

Without a manifest, setup is synchronous and protocol-ready: Git, work files and runtime storage. It installs nothing, seeds no application configuration, allocates no ports and starts no services. `--full` and dev startup require declared services. Usable untracked `.local` is shared by default when present; tracked `.local` stays branch-local. Explicit `workspace.sharedDirs` adds project directories and cannot override plans/runtime policies.

## Configuration

One selected `alignfirst.json` or `alignfirst.jsonc` contains `conventions`, `plans`, optional `developerInstructions`, `workspace` and `devServer`. A companion may select this complete family with `items.alignfirst`; sections are never merged across sources. Project-selected recipes remain branch-local. Commands still default to the target checkout as cwd.

The document requires one `schemaVersion: 1` and accepts optional URI-valued `$schema` as editor metadata. It is never fetched or used to choose runtime validation. `.json` is strict JSON; `.jsonc` accepts comments and trailing commas. Both extensions in one selected location are an error. Unknown properties and unsupported schema majors fail with upgrade guidance; invalid files never select defaults. Discovery starts at the current Git worktree root, including from nested cwd. Outside Git, project settings use the caller directory.

The editor schema ships at `alignfirst/schemas/alignfirst-v1.schema.json`. Validation uses the packaged schema without network requests. Compatible additions retain the major; future breaking majors require sequential in-memory converters retained for the CLI major. Reading never rewrites committed files. There is no converter for retired wrappers or `.alignfirst.json`.

## Manifest and project scripts

Copy [alignfirst.json](../assets/alignfirst.json) and adapt its commands. It is data, not an expression language. The asset is a Node example with an invocation-bound concurrency limit and opt-in Node startup-error preset; scripts own stack-specific details. Add `developerInstructions` only when supplying or recommending that file. `alignfirst developer-instructions` prints conventions first, then configured content with its resolved source path. It discovers no fallback filename. The optional groups are `workspace` and `devServer`.

`workspace` accepts `sharedDirs`, `gitignoredFiles`, named sequential `preSetup`, `finalize`, `purge` steps and `summary`. Finalize runs in a detached installed-CLI child; ordinary setup waits. `--detached` returns pending, and `workspace wait` joins it. Cancelling either waiter leaves an already-spawned finalizer running independently. Without a custom summary, setup and status report the workspace name, path, branch and preparation status. Failed/partial setup retains files and identity; repair the reported problem and retry the printed setup command.

`devServer` accepts `ports`, `runFiles`, `runFilesInputs`, named sequential `setup`, `servers`, `maxConcurrentDevServers` and `summary`. `dev setup` allocates ports and reconciles run files before provisioning infrastructure. It runs implicitly before startup. `workspace setup --full` adds dev setup, not service startup. A dev setup failure leaves preparation ready with a separate failure and a retry path.

### Commands and interpolation

A command is `{ "run": "shell source" }` or `{ "run": ["executable", "arg"] }`, with optional `cwd` and string-valued `env`. Arrays must be nonempty and run without a shell. Strings are POSIX shell source. Each command defaults to the target root and inherits the caller environment. Relative `cwd` resolves from that root, including package-level monorepo commands. Orphan purge instead resolves relative cwd/scripts from main.

Use simple `${{ name }}`, `${{ currentWorktree }}`, `${{ configurationDir }}`, `${{ companionDir }}`, `${{ runtimeDir }}` or `${{ ports.frontend }}` lookups in argv elements, cwd, declared env, inline content, env patches and summary text. Surrounding reference whitespace is trimmed. Everything after `ports.` is a literal key, so `${{ ports.fo-api }}` works. Scalars become strings; substitution happens once. Unknown or phase-unavailable fields fail with the field and phase. No functions, arithmetic, environment lookup, object traversal, indexing or recursive expansion exists.

Shell source is never interpolated. Use quoted ABI environment variables, such as `"$ALIGNFIRST_CURRENT_WORKTREE"`. The manifest cannot override reserved context variables. Inherited ABI variables, including both JSON context names, are removed before the current phase's context is supplied. Only `ALIGNFIRST_WORKSPACE_CONTEXT` is emitted; both JSON names are reserved against authored overrides.

### Script ABI

`ALIGNFIRST_WORKSPACE_CONTEXT` contains JSON. Stdin remains available for transformations. Every phase supplies `phase`, registered workspace `name`, absolute `currentWorktree`, absolute `mainWorktree`, `isMainWorktree`, `composeProject` and the target's absolute `runtimeDir`. The selected existing configuration supplies `configurationDir`; a configured companion supplies `companionDir` even when absent on disk. Profile-only registrations supply no companion directory. Both optional fields are omitted when unavailable. Helpers beside configuration can use `run: ["python3", "${{ configurationDir }}/scripts/prepare.py"]` while retaining the target checkout as cwd. Orphan purge retains the missing target's runtime path while using main's configuration and execution cwd. `name` is never the step/server label. `branch` is present while the target exists, with `"(detached)"` for detached HEAD; orphan purge omits it.

| Fields | Phases |
| --- | --- |
| `force`, `verbose` | `preSetup`, `finalize`, `devSetup`; purge also gets `verbose` |
| `ports` | `devSetup`, `runFileContent`, `runFilePatch`, `runFilesInputs`, `start`, `stop`, `devSummary`; empty map when portless |
| `file` | `workspaceFileContent`, `workspaceFilePatch`, `runFileContent`, `runFilePatch`; destination relative to target |
| `status` | `workspaceSummary`: `pending`, `ready` or `failed` |
| `servers` | `devSummary`: actual name/kind and applicable port/PID/log path |

Unavailable fields are omitted. Scalar conveniences are `ALIGNFIRST_NAME`, `ALIGNFIRST_CURRENT_WORKTREE`, `ALIGNFIRST_MAIN_WORKTREE`, `ALIGNFIRST_IS_MAIN_WORKTREE`, `ALIGNFIRST_COMPOSE_PROJECT`, plus branch/force/verbose when available. Booleans use `true`/`false`. Read literal port names from the JSON map rather than normalizing them into environment names.

| Command role | stdin | stdout |
| --- | --- | --- |
| Lifecycle/start/stop | Closed | Step output or log |
| Content producer | Closed | UTF-8 content |
| File transform | Current UTF-8 content | Replacement UTF-8 content |
| Summary | Closed | Summary text |
| Computed inputs | Closed | JSON object with string values |

Send diagnostics to stderr and propagate launch, signal and nonzero failures. Steps run sequentially. SIGINT/SIGTERM cancel active lifecycle commands and readiness waits; cancelled file generation stops before writing. Startup cancellation waits for rollback with a fresh cleanup lifetime. An attached foreground session only detaches on interruption; it does not own the running services. Only purge steps accept `continueOnError`; ordinary failures allow later attempts, retain cleanup state and make the operation fail. Cancellation waits for owned commands to terminate and prevents later steps, including those following `continueOnError`.

### Files and input fingerprints

Each file entry has `path`, `source`, optional `patch` and `optional`. Put install/build/test inputs in `workspace.gitignoredFiles`; put port-bearing/runtime inputs in `devServer.runFiles`. One destination cannot occur in both. Committed and staged files, Git metadata, the reserved registry subtree (including ancestors and symlink aliases) and symlink escapes are protected.

Sources are `{ "kind": "mainWorktree", "fallback": ".env.example" }`, `{ "kind": "committed", "path": ".env.example" }`, or `{ "kind": "content", "content": <text-output> }`. Main sources prefer customized main content, falling back to a template in the target branch. Text output is a string or `{ "command": <command> }`. Script-based source selection reads main/branch files using the ABI and emits selected content.

Patches are `{ "env": { "PORT": "${{ ports.frontend }}" } }` or `{ "command": <command> }`. Transform scripts are pure and idempotent; the kernel checks idempotence and owns writes. Use scripts for JSON/TOML escaping, structural edits, conditional deletion and URL preservation. Do not mutate files in place from hooks.

Setup reapplies owned patches; `--force` reseeds workspace files. Starts preserve unrelated local edits until ports or declared inputs change. Deleted run files are recreated. Generated run content without a patch is regenerated when reconciliation requires it.

`runFilesInputs` is an environment-name array or `{ "command": <command> }` producing a string-valued JSON object. Use computed inputs for validated domains or file-derived settings. Defined values are SHA-256 fingerprinted, including empty strings; removing a formerly defined value invalidates the basis. Warnings expose keys only. Never include secrets in the input basis.

### Port range

`devServer.ports` is the sole range declaration: `{ "first": 8100, "last": 8199, "declare": ["frontend"] }`, optionally `exclude`. Size for port names × concurrent workspaces. A declaration may be `{ "name": "frontend", "mainWorktree": 8100, "range": { "first": 8100, "last": 8119 } }` for a main pin or dedicated range. Ports are stable until reconciliation requires movement. `dev setup --reset-ports` reallocates while stopped. `aligndev project free-ports` looks up a free block in an inventory marker; it does not reserve it.

### Services

A spawn service has unique `name`, `exec`, optional named/numeric `port`, required `ready: { "log": "regex source" }` and optional `error`. Errors accept `preset: "node"`, `log: "regex source"`, or both; an empty error descriptor is invalid. The Node preset detects common nodemon crashes, Node fatal output, missing modules, syntax errors and unhandled promise rejections. These are startup heuristics, not complete failure detection. Either preset or custom match fails startup. Keep framework markers such as `[ExceptionHandler]` in custom expressions. Omitting `error` installs no log detector. Logs/PIDs/process groups are kernel-owned; process exit still fails startup. There is no built-in HTTP/TCP readiness. A portless service omits `port`.

A command service has `kind: "command"`, `name`, `start` and optional `stop`. Start returns only after the resource is ready; custom database probes belong in scripts. Failed starts clean their partial effects or leave them recoverable by purge. Omitted stop deliberately retains the resource until purge. Servers launch in array order and stop in reverse; ordered spawning does not promise readiness dependencies. Managed environments require at least one spawn service; callback-only container stacks are not PID-supervised.

`maxConcurrentDevServers` accepts a nonnegative safe integer or an environment binding such as `{ "env": "PROJECT_DEV_LIMIT", "default": 5 }`. Omission and zero mean unlimited. An unset variable selects the default; a defined value must contain only decimal digits and fit a safe integer. Empty, signed, fractional, exponent and whitespace-padded values fail before startup effects. Resolution uses the invocation environment only on a real start/restart. Already-running `up`, non-owning foreground attachment, reports, cleanup and setup (including `--full`) do not evaluate overrides. The limit counts live dev environments within this repository, not processes or machine-wide environments. The CLI loads no dotenv files; project scripts may explicitly read their own ignored settings. At capacity, `--evict` stops the oldest environment using its target recipe. A stop failure prevents replacement startup. Exclusive per-worktree startup claims in `dev-startups.json` hold a PID and unique token across setup/startup; live claims do not age out. Instance tokens protect replacement runs from stale rollback or cleanup. These claims do not make the cross-worktree cap atomic; simultaneous starts can exceed it.

### Public URLs

For assistant projects, scripts derive browser-facing URLs from the allocated port and `REMOTE_DEV_DOMAIN` (HTTPS `https://p<port>.<domain>`), else `REMOTE_DEV_HOST` (`http://<host>:<port>`), else localhost. Declare both as inputs so removal returns to localhost. Preserve intentionally edited unrelated URL settings. Server-to-server URLs may stay loopback. Bind on all interfaces only when required by direct remote access.

A dev summary can read reconciled runtime sidecars and actual server results. Show public URLs, PID/log paths for spawn services and resource/log commands for command services; omit passwords. Document the deployment's environment export in the project README.

## Python monorepos

The same CLI can prepare isolated `.venv`, per-worktree databases and multiple package processes. For example, use finalize steps with `run: ["uv", "sync", "--frozen"]`, and a spawn command with `cwd: "packages/api"`, `run: ["../../.venv/bin/python", "-m", "api"]`, and `env: { "PORT": "${{ ports.api }}" }`. Use the application's actual log-ready regex. A second package gets its own cwd/env and named port. Python transformation scripts read `json.loads(os.environ["ALIGNFIRST_WORKSPACE_CONTEXT"])`, consume `sys.stdin.read()` and write replacement content to stdout. Scripts can place infrastructure sidecars under the context's `runtimeDir`, which follows project or companion placement. Other application files still require explicitly ignored branch-local destinations.

## Cleanup and external owners

`workspace setup -c <branch> --from <ref>` creates; `workspace setup <branch>` reuses; `--path <path>` chooses a destination. Without branch/path, setup adopts the current registered Git root without switching branches. `workspace list --json` combines Git, resource registrations and external runtime owners without adopting or cleaning them. Rows expose nullable `runtimeDir` and `runtimeState` (`active`, `retained` or `deletionPending`). Runtime-only rows have null names/recipes, no ports and unprepared status.

Paseo or another external owner runs `workspace setup` inside its checkout, then `workspace teardown` before its own deletion. Preserve Paseo's archive-before-removal procedure. Adoption does not transfer Git deletion ownership.

`dev down` stops owned processes and command services. `workspace teardown` additionally runs destructive purge and releases identity/ports, preserving files, dependencies, links and Git state. `workspace remove` adds protected Git deletion and preserves branches. `workspace prune` explicitly cleans orphans before pruning Git metadata. Companion teardown retains runtime files and ownership after releasing resource names/ports. Remove disposes the target runtime after Git succeeds. Prune also disposes clean runtime-only orphans after external Git deletion, without another purge. Deletion failure retains discoverable deletionPending state; retry handles missing runtime directories. Live preparation/finalizers and startup claims block cleanup, even with a missing checkout. Wait for their owners first. Force bypasses dirtiness only; it never bypasses protected targets or failed cleanup.

### Teardown by name

Existing targets use their current branch's recipe, commands, cwd and env. Missing manifest-backed targets require main's purge recipe and execute there with the missing target's recorded identity/path. Name/label resources with `composeProject` or durable name-keyed records under main; do not depend on deleted target files. Main must cover resource families from participating branches. Use explicit Compose `-p` on every operation. Stop and purge scripts must be idempotent and propagate failures. Failed cleanup retains records even after PIDs exit. The workspace's independent `cleanupPending` gate blocks setup, dev setup and startup until successful workspace cleanup completes stop and purge. A successful `dev down` alone cannot clear that gate; repair and retry `workspace teardown`.

An abruptly killed cleaner can leave destructive stop/purge subprocesses alive. An abandoned `cleanupOwner` therefore refuses further cleanup, including force, and keeps setup/start gated. Freeze all lifecycle callers sharing the selected runtime registry, preserve registry evidence and establish that all old cleanup subprocesses and delegated work have terminated. If that cannot be established, retain the gate. Only after quiescence and a fresh identity check may an operator clear that exact entry's `cleanupOwner` in the selected `workspaces.json`. Preserve `cleanupPending`, identity, recipe, ports, runtime generation, dev/startup retry records and unrelated entries, then retry cleanup before re-adoption or external Git deletion. A dead CLI PID alone is insufficient. Ordinary failure/cooperative cancellation remains retryable after owned execution finishes; scripts must finish owned work before returning.

## Agent Instructions

In coding-agent `AGENTS.md` and, for an assistant, the explicitly referenced developer guide, describe the project's readiness and point to `npx -y alignfirst workspace --guide`. Record stack-specific commands and quirks, not a duplicate command reference. With protocols, retain the canonical context bootstrap; otherwise document branch/commit conventions and exclude effective plans, `.local` and `.local-wt` from broad searches.

## The AlignDev Contract

An assistant always uses `alignfirst workspace` for preparation, with or without a manifest. Default readiness is protocol-ready. Coding delegation and its native permissions remain separate; shared symlinks grant no sandbox access. A companion runtime needs no checkout runtime directory or exclusions. Explicit shared directories, project commands and Git metadata remain independently writable. Before changing placement, clean resources under the old selection. CLI unregister refuses outstanding resources/disposal, including force; plain unregister can retain clean data and reports the absolute paths whose automatic discovery is being removed. Manual registry edits have no placement-history recovery.
