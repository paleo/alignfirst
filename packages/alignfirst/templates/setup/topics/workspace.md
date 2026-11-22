# Workspace Recipe

`{{CMD}} workspace` and `{{CMD}} dev` prepare isolated Git worktrees for any stack. Git is required. Project commands keep their own toolchain: Python, Rust and other non-Node repositories need no `package.json`, JavaScript wrapper or local workspace dependency. Never recommend reimplementing the kernel for another language.

This topic is the recipe authoring reference. The lifecycle commands (setup, list, teardown, remove, prune, dev) and the behavior without a recipe are in `{{CMD}} workspace --guide`.

Installations with `.alignfirst.json`, workspace wrappers or old registries first follow `{{CMD}} setup guide upgrade-workspaces`. Never run the new commands against unaccounted old resource state.

## Implementation process

1. Inspect the repository from a clean working tree. Identify the work files, ignored data, runtime requirements, install, build and test commands, file templates, ports, service readiness logs and resource ownership.
2. Present the proposed preparation, services and destructive cleanup procedures. Obtain approval before changes.
3. Prepare the work files and runtime storage (below). Add a recipe only for project-specific behavior.
4. Validate with `{{CMD}} config --json`, and read `{{CMD}} workspace --guide`.
5. With authorization, commit the scaffolding before creating a disposable linked worktree, so that it contains the recipe and the project scripts. Exercise setup, dev when declared, stop and cleanup. Preserve user branches and shared data. Do not push unless separately authorized.

## Required baseline

Setup requires usable effective work files before the first linked worktree; see `{{CMD}} setup guide work-files`. For a workspace-only adoption, `{{CMD}} setup init --no-instructions` creates the work files, their ignore rules and an `alignfirst.json` without conventions.

Main can be adopted before its initial commit. Staged plans or runtime paths, shared sources and generated-file destinations stay protected. Make an initial commit before creating a linked workspace. Commit templates before relying on recipes that read committed sources.

### Runtime storage

With project placement, each worktree has its own `.local-wt/`, ignored, untracked and free of conflicting files or symlinks. Setup creates it when absent. Its kernel-owned `workspace-registry/` subtree lives in main; each linked worktree links only to its own main's registry.

`setup init` adds the `.local-wt/` ignore rule when the runtime is project-local, and the report shows whether it is ignored. A tracked `.gitignore` rule needs the user's approval. When project files must stay unchanged, `--git-exclude` writes a root-anchored rule to `.git/info/exclude` instead. Local exclusions still change Git metadata.

With the companion's `workspaceRuntime` effectively `companion`, the registry is `<companion>/.local-wt/workspace-registry`, and each real worktree gets a path-derived runtime directory under `<companion>/.local-wt/worktrees/`. This creates no checkout runtime directory, placeholder, registry link or runtime ignore rule. Companion placement does not suppress explicit shared-directory links, project hooks, generated application files or Git operations. Generated-file entries stay confined to the checkout.

Preserve and repair conflicting or redirected registry state before retrying.

### Shared `.local`

When `.local/` exists and Git ignores it, list it explicitly in `workspace.sharedDirs`; the report shows both facts. First verify that `git ls-files -- .local` is empty, and report any tracked or staged conflict before proceeding. Preserve the other entries, and never create `.local` just to list it. Explicit sharing cannot override the plans and runtime policies.

## Configuration

The recipe lives in the `workspace` and `devServer` sections of the selected configuration file; the format is in `{{CMD}} setup guide configuration`. A recipe selected from the project is branch-local. A companion can supply the complete document, with preparation, services, ports and cleanup. Commands still default to the target checkout as cwd. Helpers beside the configuration use `${{ configurationDir }}` in argv.

## Manifest and project scripts

Copy this sample and adapt its commands and conventions (`{{CMD}} setup guide protocols`):

```json
{{SAMPLE_MANIFEST}}
```

The sample is a Node example, with a concurrency limit bound to the invocation and the opt-in Node startup-error preset. The manifest is data, not an expression language; scripts own the stack-specific details. `workspace` and `devServer` are both optional. `assistantInstructionsFile` belongs to `{{CMD}} setup guide assistant-project`.

`workspace` accepts `sharedDirs`, `gitignoredFiles`, the named sequential steps `preSetup`, `finalize` and `purge`, and `summary`. Finalize runs in a detached child of the installed CLI. Cancelling a waiter leaves an already-spawned finalizer running on its own. Without a custom summary, setup and status report the workspace name, path, branch and preparation status.

`devServer` accepts `ports`, `runFiles`, `runFilesInputs`, the named sequential `setup` steps, `servers`, `maxConcurrentDevServers` and `summary`. `dev setup` allocates ports and reconciles run files before provisioning infrastructure. It runs implicitly before startup.

### Commands and interpolation

A command is `{ "run": "shell source" }` or `{ "run": ["executable", "arg"] }`, with optional `cwd` and string-valued `env`. An array must be nonempty and runs without a shell. A string is POSIX shell source. Each command runs from the target root and inherits the caller's environment. A relative `cwd` resolves from that root, which serves package-level commands in a monorepo. Orphan purge resolves relative cwd and scripts from main instead.

Argv elements, cwd, declared env, inline content, env patches and summary text accept simple lookups: `${{ name }}`, `${{ currentWorktree }}`, `${{ configurationDir }}`, `${{ companionDir }}`, `${{ runtimeDir }}` or `${{ ports.frontend }}`. Whitespace around the reference is trimmed. Everything after `ports.` is a literal key, so `${{ ports.fo-api }}` works. Scalars become strings, and substitution happens once. An unknown field, or one unavailable in the phase, fails with the field and the phase. There are no functions, arithmetic, environment lookups, object traversal, indexing or recursive expansion.

Shell source is never interpolated: use quoted ABI environment variables, such as `"$ALIGNFIRST_CURRENT_WORKTREE"`. The manifest cannot override reserved context variables. Inherited ABI variables, including both JSON context names, are removed before the current phase's context is supplied. Only `ALIGNFIRST_WORKSPACE_CONTEXT` is emitted; both JSON names are reserved against authored overrides.

### Script ABI

`ALIGNFIRST_WORKSPACE_CONTEXT` contains JSON; stdin stays available for transformations. Every phase supplies `phase`, the registered workspace `name`, absolute `currentWorktree` and `mainWorktree`, `isMainWorktree`, `composeProject`, and the target's absolute `runtimeDir`. `name` is never a step or server label. `branch` is present while the target exists, with `"(detached)"` for a detached HEAD; orphan purge omits it.

The selected existing configuration supplies `configurationDir`. A configured companion supplies `companionDir`, even when it is absent on disk; a profile-only registration supplies none. Both are omitted when unavailable. A helper beside the configuration runs as `run: ["python3", "${{ configurationDir }}/scripts/prepare.py"]` and keeps the target checkout as cwd. Orphan purge keeps the missing target's runtime path, and uses main's configuration and execution cwd.

| Fields | Phases |
| --- | --- |
| `force`, `verbose` | `preSetup`, `finalize`, `devSetup`; purge also gets `verbose` |
| `ports` | `devSetup`, `runFileContent`, `runFilePatch`, `runFilesInputs`, `start`, `stop`, `devSummary`; an empty map when portless |
| `file` | `workspaceFileContent`, `workspaceFilePatch`, `runFileContent`, `runFilePatch`; destination relative to the target |
| `status` | `workspaceSummary`: `pending`, `ready` or `failed` |
| `servers` | `devSummary`: actual name and kind, with the applicable port, PID and log path |

Unavailable fields are omitted. The scalar conveniences are `ALIGNFIRST_NAME`, `ALIGNFIRST_CURRENT_WORKTREE`, `ALIGNFIRST_MAIN_WORKTREE`, `ALIGNFIRST_IS_MAIN_WORKTREE` and `ALIGNFIRST_COMPOSE_PROJECT`, plus branch, force and verbose when available. Booleans are `true` or `false`. Read literal port names from the JSON map; do not normalize them into environment names.

| Command role | stdin | stdout |
| --- | --- | --- |
| Lifecycle, start, stop | Closed | Step output or log |
| Content producer | Closed | UTF-8 content |
| File transform | Current UTF-8 content | Replacement UTF-8 content |
| Summary | Closed | Summary text |
| Computed inputs | Closed | JSON object with string values |

Send diagnostics to stderr, and propagate launch, signal and nonzero failures. Steps run sequentially. SIGINT and SIGTERM cancel active lifecycle commands and readiness waits; cancelled file generation stops before writing. Startup cancellation waits for rollback, with a fresh cleanup lifetime. An attached foreground session only detaches on interruption; it does not own the running services. Only purge steps accept `continueOnError`. An ordinary failure lets later attempts run, keeps the cleanup state and makes the operation fail. Cancellation waits for owned commands to terminate and prevents later steps, including those after a `continueOnError` step.

### Files and input fingerprints

Each file entry has `path`, `source`, and optional `patch` and `optional`. Put install, build and test inputs in `workspace.gitignoredFiles`, and port-bearing or runtime inputs in `devServer.runFiles`. A destination cannot appear in both. Committed and staged files, Git metadata, the reserved registry subtree (with its ancestors and symlink aliases) and symlink escapes are protected.

A source is `{ "kind": "mainWorktree", "fallback": ".env.example" }`, `{ "kind": "committed", "path": ".env.example" }` or `{ "kind": "content", "content": <text-output> }`. A main source prefers the customized content of main, and falls back to a template in the target branch. Text output is a string or `{ "command": <command> }`. Script-based source selection reads main and branch files through the ABI and emits the selected content.

A patch is `{ "env": { "PORT": "${{ ports.frontend }}" } }` or `{ "command": <command> }`. Transform scripts are pure and idempotent; the kernel checks idempotence and owns the writes. Use scripts for JSON or TOML escaping, structural edits, conditional deletion and URL preservation. Never mutate files in place from hooks.

Setup reapplies owned patches; `--force` reseeds workspace files. Starts preserve unrelated local edits until ports or declared inputs change. Deleted run files are recreated. Generated run content without a patch is regenerated when reconciliation requires it.

`runFilesInputs` is an array of environment names, or `{ "command": <command> }` producing a JSON object of strings. Use computed inputs for validated domains or settings derived from files. Defined values are SHA-256 fingerprinted, including empty strings; removing a formerly defined value invalidates the basis. Warnings expose keys only. Never put secrets in the input basis.

### Port range

`devServer.ports` is the sole range declaration: `{ "first": 8100, "last": 8199, "declare": ["frontend"] }`, optionally with `exclude`. Size it for the number of port names times the concurrent workspaces. A declaration can be `{ "name": "frontend", "mainWorktree": 8100, "range": { "first": 8100, "last": 8119 } }`, for a pinned main port or a dedicated range. Ports stay stable until reconciliation requires a move. `dev setup --reset-ports` reallocates them while stopped. `aligndev project free-ports` looks up a free block in an inventory marker without reserving it.

### Services

A spawn service has a unique `name`, `exec`, an optional named or numeric `port`, a required `ready: { "log": "regex source" }` and an optional `error`. A portless service omits `port`. `error` accepts `preset: "node"`, `log: "regex source"`, or both; an empty descriptor is invalid. The Node preset detects common nodemon crashes, Node fatal output, missing modules, syntax errors and unhandled promise rejections. These are startup heuristics, not complete failure detection. A match of either the preset or the custom expression fails startup. Keep framework markers such as `[ExceptionHandler]` in custom expressions. Without `error`, no log detector is installed. The kernel owns logs, PIDs and process groups, and a process exit still fails startup. There is no built-in HTTP or TCP readiness.

A command service has `kind: "command"`, `name`, `start` and an optional `stop`. Start returns only once the resource is ready; custom database probes belong in scripts. A failed start cleans its partial effects or leaves them recoverable by purge. Without `stop`, the resource deliberately stays until purge. Servers launch in array order and stop in reverse order; the order promises no readiness dependency. A managed environment requires at least one spawn service; callback-only container stacks are not PID-supervised.

`maxConcurrentDevServers` accepts a nonnegative safe integer, or an environment binding such as `{ "env": "PROJECT_DEV_LIMIT", "default": 5 }`; its value rules are in `{{CMD}} workspace --guide`. The binding is resolved from the invocation environment only on a real start or restart. An already-running `up`, a non-owning foreground attachment, reports, cleanup and setup, including `--full`, never evaluate it. The CLI loads no dotenv file; project scripts may read their own ignored settings explicitly. At capacity, `--evict` stops the oldest environment with its target's recipe, and a stop failure prevents the replacement startup. Exclusive per-worktree startup claims in `dev-startups.json` hold a PID and a unique token across setup and startup; live claims do not age out. Instance tokens protect replacement runs from stale rollback or cleanup. The claims do not make the cross-worktree cap atomic: simultaneous starts can exceed it.

### Public URLs

For assistant projects, scripts derive browser-facing URLs from the allocated port and `REMOTE_DEV_DOMAIN` (`https://p<port>.<domain>`), else `REMOTE_DEV_HOST` (`http://<host>:<port>`), else localhost. Declare both variables as inputs, so that removing them returns to localhost. Preserve intentionally edited unrelated URL settings. Server-to-server URLs may stay on loopback. Bind on all interfaces only when direct remote access requires it.

A dev summary can read reconciled runtime sidecars and actual server results. Show public URLs, PID and log paths for spawn services, and resource and log commands for command services; omit passwords. Document the deployment's environment export in the project README.

## Python monorepos

The same CLI can prepare an isolated `.venv`, per-worktree databases and several package processes. For example, use a finalize step with `run: ["uv", "sync", "--frozen"]`, and a spawn command with `cwd: "packages/api"`, `run: ["../../.venv/bin/python", "-m", "api"]` and `env: { "PORT": "${{ ports.api }}" }`. Use the application's actual log-ready regex. A second package gets its own cwd, env and named port.

Python transform scripts read `json.loads(os.environ["ALIGNFIRST_WORKSPACE_CONTEXT"])`, consume `sys.stdin.read()` and write the replacement content to stdout. Scripts can place infrastructure sidecars under the context's `runtimeDir`, which follows the project or companion placement. Other application files still need explicitly ignored branch-local destinations.

## Cleanup

The cleanup commands and their guarantees are in `{{CMD}} workspace --guide`. An agent that removes a workspace directly uses `workspace remove`, even when an external tool created it. In `workspace list --json`, rows expose nullable `runtimeDir` and `runtimeState` (`active`, `retained` or `deletionPending`); runtime-only rows have no ports and an unprepared status. A failed deletion keeps a discoverable `deletionPending` state, and a retry handles missing runtime directories.

### Teardown by name

An existing target uses its current branch's recipe, commands, cwd and env. A missing manifest-backed target requires main's purge recipe, which runs there with the missing target's recorded identity and path. Name or label resources with `composeProject`, or with durable name-keyed records under main; never depend on deleted target files. Main's recipe must cover the resource families of every participating branch. Pass an explicit Compose `-p` on every operation. Stop and purge scripts must be idempotent and propagate failures.

Failed cleanup keeps its records, even after the PIDs exit. The workspace's `cleanupPending` gate then blocks setup, dev setup and startup until a successful workspace cleanup completes both stop and purge. A successful `dev down` alone cannot clear that gate: repair, then retry `workspace teardown`.

An abruptly killed cleaner can leave destructive stop or purge subprocesses alive. An abandoned `cleanupOwner` therefore refuses further cleanup, even with force, and keeps setup and start gated. To recover:

1. Freeze every lifecycle caller sharing the selected runtime registry, and preserve the registry evidence.
2. Establish that every old cleanup subprocess and delegated work has terminated. When that cannot be established, keep the gate. A dead CLI PID alone is insufficient.
3. After quiescence and a fresh identity check, an operator may clear that exact entry's `cleanupOwner` in the selected `workspaces.json`. Preserve `cleanupPending`, identity, recipe, ports, runtime generation, dev and startup retry records, and unrelated entries.
4. Retry cleanup before re-adoption or external Git deletion.

Ordinary failure and cooperative cancellation stay retryable once the owned execution finishes. Scripts must finish their owned work before returning.

## Project documentation

Keep generated entry points minimal, and preserve useful existing content.

`README.md` holds the local environment installation procedure. With workspaces, it has a `## Local environment installation` section containing `{{CMD}} workspace setup`, in the project's invocation form. Include prerequisites or manual steps only when that procedure needs them. Leave out, by default, generic tooling explanations, optional global installations, command catalogs and pending-work notices.

With the protocols, the bootstrap section of `{{CMD}} setup guide protocols` covers workspace guidance in `AGENTS.md`. A workspace-only adoption adds no protocol instructions, and keeps the project's own rules. Keep lifecycle hooks of external tools in those tools' configuration, as `{{CMD}} setup guide paseo` does for Paseo. The assistant guide and the AlignDev contract are in `{{CMD}} setup guide assistant-project`.
