---
title: aligndev Architecture
summary: How `aligndev` works internally — coding sessions and adapters, lightweight worktrees, project inventory and port claims.
read_when:
  - onboarding to the aligndev codebase
  - changing how `aligndev code` launches, tracks or terminates a coding agent
  - changing session files, `aligndev code status` or the `_aligndev` location
  - changing lightweight worktree creation, setup, inventory or removal
  - changing the project inventory, its marker or port claims
  - adding a coding agent
---

# aligndev Architecture

`aligndev` is the CLI an assistant uses: it prints the playbook (`guide`), delegates work to a coding agent (`code`), inventories the host's projects (`project`), and manages lightweight Git worktrees (`worktree`). Its users are agents, so its `--help` and guides are the user reference. This document covers what they leave out. The [README](../packages/aligndev/README.md) covers setup and configuration.

## Source Structure

| Path | Responsibility |
| --- | --- |
| `src/cli.ts` | Entry point: dispatches commands and loads settings; creates command-scoped model discovery. |
| `src/config.ts` | `~/.alignfirst/aligndev.settings.json`: tolerant settings, reference validation, effective selection and child environment. |
| `src/code/` | `aligndev code`: arguments, prompt, run, session file, adapters, models, quota. |
| `src/guide/` | `aligndev guide [--channel <surface>]`: topics by context, the template renderer, and the project's guide file (`guide-file.ts`). |
| `src/project/` | `aligndev project`: discovery, markers, status, port allocation; AlignFirst report parsing and work-files gate calls. |
| `src/worktree/` | Git-backed worktree inventory, add/setup preparation, directory policy and non-force removal. |
| `templates/guide/` | The dispatcher, the playbook and the guides, rendered per platform and surface. |

Templates use `{{ALIGNDEV}}`, `{{ALIGNFIRST}}` placeholders for rendered command forms. `src/command-form.ts` resolves invocation once through `@alignfirst/docmap/invocation`, separating launcher (`direct`, `packageRunner`, `projectScript`) from actual runtime (`node`, `bun`). Explicit runner evidence wins over lockfiles; a project script requires manifest, entry-point and immediate-parent agreement. User-agent metadata alone does not prove either a script or a runtime.

Under npm/npx, counterpart commands use `npx -y alignfirst`; under Bun runtime they use `bunx --bun alignfirst`. Verified scripts are retained only for self follow-ups. Direct Bun entry launches also produce explicit Bun package-runner commands. Published bins keep Node shebangs, so ordinary `bunx` normally uses Node when it is installed. No automatic runtime re-execution occurs.

`src/alignfirst-cli.ts` spawns the structured executable and fixed argv plus operation arguments, never split rendered text. This covers config reports, plans checks, ticket open/reservation/catchup, companion context and diagnostic `--version` probes. Missing/outdated-report diagnostics describe the selected runner, explicit Bun runtime when applicable, and direct executable resolution. Delegated prompts use the same counterpart selection; the native coding agent keeps its own executable policy and prerequisites.

A render has a platform, a surface under `openclaw` (`--channel slack|discord|app`), and a guide-file condition under `codingAgent`. Without a topic, `aligndev guide` prints the dispatcher, the only `openclaw` render without a surface. `code` without `--channel` renders the `app` surface, for operators who validate profiles outside any session. `--channel` alone prints the surface's playbook. The entry topics, `working-session` and `channel-handling`, print the playbook first. The topics are keyed by context: `thread` (Slack and Discord), `app`, `codingAgent`. `{{GUIDE}}` renders as `aligndev guide --channel <surface>` or `aligndev guide`, so every later guide call keeps the surface.

Variants sit in blocks, each marker alone on its line. A block names a fact, and a line is kept when every block around it holds:

- A platform block, `{{#openclaw}}` or `{{#codingAgent}}`, sits at the top level.
- A surface block, `{{#slack}}`, `{{#discord}}` or `{{#app}}`, and `{{#thread}}` never sit inside a `{{#codingAgent}}` block.
- `{{#conversation}}` sits anywhere.
- A condition block, `{{#developers}}`, `{{#readme}}`, `{{#noGuide}}` or `{{#hasGuide}}` (both guide files), sits inside a `{{#codingAgent}}` block, at any depth.

`thread` and `conversation` are derived: `thread` holds on Slack and Discord, `conversation` on `app` and under `codingAgent`.

The condition names the project's guide file for the assistant. Under `codingAgent`, `aligndev guide` resolves it once per playbook-topic call: it runs `alignfirst config --json` in PROJECT_PATH, the main worktree of the working directory, and a report error fails the command. `DEVELOPERS.md` at its reported location gives `developers`; otherwise `README.md` at the root of PROJECT_PATH gives `readme`; otherwise, outside git included, `noGuide`. Ordinary OpenClaw playbooks read no report. The `code` topic reads the report in the actual cwd for project profile selection, independently of the main-worktree guide-file policy.

## Running the Agent

`aligndev code` runs the agent as a direct **foreground** child until it exits. It writes the transcript to a durable per-run file and, unless `--quiet` is given, streams it to stdout. Quiet mode keeps the initial `Session file:` line, new child `Session ID:` and failure diagnostics. The CLI never backgrounds or detaches itself.

- Under OpenClaw, the assistant runs it through `exec` with `background: true` and `timeoutSeconds: 0`, and chains `openclaw system event --mode now --session-key <key>` onto the command.
- Claude Code/Codex parents retain their established background facilities and sandbox elevation. Claude Code wakes the parent on exit; where no completion bridge is configured, Codex uses the next-user-turn status fallback. Pi work does not certify or replace these integrations.
- A persistent Pi parent uses the generic `background` tool to launch an ordinary quoted CLI command with `--quiet` and a unique per-run `--meta`. The guide owns those flags, not the extension. A notice triggers a handle-ownership check, then exact-file or unique-key `status --result` retrieval from the original worktree. Parent host and child adapter are independent. See [Pi Extensions](pi-extensions.md) for package and native delivery boundaries.

The prompt reaches the agent through stdin. A new session's prompt opens with a run context. It tells the agent that ending its turn kills its subagents and background commands, so it must wait for them first. The effective profile starts with a copy of the caller environment, removes verified forced-Bun launcher shim directories from inherited PATH and their matching runtime metadata, removes its `unset`, then applies literal `env` values and the directory selection (set a resolved string or remove the native variable for null), strips parent session identity (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`, Pi markers, …), then applies adapter-required values. `buildAgentEnv` owns this order; Claude's background-wait ceiling always wins. Ordinary Bun installations and explicit profile PATH overrides remain intact. This external-process baseline also applies to explicit quota sources; owned AlignFirst calls retain the original caller environment and explicit Bun runner. The finalized `CodeConfig.childEnv` reaches model discovery, adapter state, spawn and Codex rollout lookup. Caller environments are immutable; run metadata contains no environment snapshot.

### Session File

The session file is the durable handoff of a run. Its frontmatter holds `profile` (named selection or null), `agent`, the user-facing `model`, `sessionId`, `status` (`running`, then `succeeded` or `failed`) and an optional `exitReason`; a `---- Result ----` block closes it. The block lists every completed response oldest first, separated by `---- Later result ----`. Each non-empty Claude `result` and each Pi assistant message ending with `stop` counts as a response. Earlier responses also precede failure or termination text. The completion turn finds it with `aligndev code status`. A response containing `---- Result ----` on its own line can be truncated by status because the legacy format also uses that line as its boundary. Fixing this ambiguity requires unambiguous payload framing with legacy-file support; it remains a follow-up limitation. String metadata containing control characters is JSON-quoted on one physical line, preserving embedded newlines in exact profile/model names through completion and resume.

Each new record carries `machineId`, a random UUID read from `~/.alignfirst/machine-id`, created on first use with an exclusive write. Concurrent creators read the winning id. An empty or unreadable file is an error; older records read as `machineId: null`.

Session files live under the project's `_aligndev` location, read from `alignfirst config --json`: `<ticket>/_aligndev/`, or `_aligndev/` without a ticket. That location is below the project's `.plans/`, unless a companion directory holds a separate tree.

A run is written as `<stamp>.running.md` and renamed to `<stamp>.md` when it ends, by completion or by sealing. `alignfirst sync` leaves `_aligndev/*.running.md` out of its snapshots, so a log reaches the work-files repository only once its run has ended. `code status <path>` resolves a retained `.running.md` path to the completed file. Records written before this convention keep their name and their `running` status until their run ends.

The CLI creates a missing companion before launch, independently of permission mode. Claude Code/Codex normal modes add it through `--add-dir`; Pi uses ordinary OS access. When some AlignFirst files live there, a new session's prompt starts with `alignfirst context`. See [Companion Directories](companion-directories.md).

`status` accepts exactly one file, `--ticket`, `--no-ticket`, or `--meta` selector. Scope/key selectors choose the newest matching active run, so asynchronous callers use a unique key per run and retain the resolved exact path. `status --result` adds the terminal Result block when present, without transcript output; running runs show metadata only. It has no numeric final-text cap. `readCompletion` currently reads the whole file into memory. A successful status query exits `0` even when the run failed; launch/run exits are `0` for success, `1` for ordinary failure and `2` for authentication.

### Termination and Status

On handled termination, the CLI seals the session file (`status: failed`, `exitReason: terminated`), sends `SIGTERM` to its child, and escalates to `SIGKILL` after its two-second grace. The parent host owns attached process-tree supervision; this does not promise crash-proof descendant cleanup.

Abrupt host loss, a crash or `SIGKILL` can leave a stale `running` status. Status queries and launch scans seal a record as `terminated` only when its `machineId` matches this installation and its process is conclusively gone: probing the pid returns `ESRCH`, or the pid exists and its readable Linux start time differs from the recorded one. Status prints `machineId` after `pid`.

Foreign and legacy records stay untouched, as do records with no pid or an inconclusive process probe (`EPERM`, or a live pid with no recorded or readable current start time). Running records still block applicable launches. Guard errors name their path; foreign and legacy records must be checked on their machine, or have their `status` set by hand once the run has ended.

The `contextTokens` line reports what the run left in the agent's context window; a resumed session keeps growing.

### Authentication

When the agent's login on the host is missing or expired, `aligndev code` detects the failure in the agent's stream, seals the session file with `exitReason: auth_required`, and exits `2` with a diagnostic naming the selected agent/profile and native configuration context. `describeNativeStorage` shares storage-origin labels across help, guides and failures: string `configDir`, explicit unset by `configDir: null` with native defaults, profile environment override, inherited variable or profile removal, including HOME/USERPROFILE context. Environment values are never printed. Login instructions require the child's effective environment (`unset/env/configDir`, HOME, PATH and credential routing) and cwd; a bare native login in another shell may select another account. The guide tells the assistant to report it, never to retry.

### Tickets

A new protocol session needs a ticket. `--no-ticket` reserves the next side ticket through `alignfirst ticket --side`. `--catchup` loads the ticket's history through `alignfirst ticket --catchup` before the protocol and message. A protocol run is refused while another protocol run is active in the same worktree or on the same ticket, since `alignfirst ticket --next` reserves no work-file prefix. Runs without a protocol neither block nor are blocked.

## Coding Agents

Three adapters (`claude-agent.ts`, `codex-agent.ts`, `pi-agent.ts`) build CLI arguments, parse streams and recognize authentication failures. Pi targets 1.3.0's JSON/print settlement contract, preserves its native conversation for resume, and requires that resume use the recorded directory. The synchronous subagent package is optional in that child environment; it is not an adapter dependency.

- **Permissions:** normal runs use Claude's `--permission-mode auto` or Codex's `--sandbox workspace-write`. The profile's `skipPermissions` selects their bypass flags. Pi uses ordinary OS permissions and saved project trust, without forced approval; that setting has no effect on Pi.
- **Models:** Claude's defaults are `fable`, `opus`, `sonnet`, `haiku`; Codex's are `astra`, `sol`, `terra`, `luna`. A selected Codex alias resolves through `codex debug models --bundled`. Pi accepts nonblank native selectors unchanged, preferably `provider/model` with optional thinking suffix, without a finite default allowlist. A nonempty profile `models` replaces accepted names; otherwise configured alias names extend Claude/Codex defaults. `expandModelAlias` expands exactly once after accepted-name validation, before the executable resolver. Without `--model`, new sessions use profile `defaultModel`, else the child's default; resumes retain and validate the latest recorded model, ignoring new-session defaults. A disallowed retained name requires `--model`; null retains the native conversation default. Current alias mappings apply to retained names. The file records the chosen name, or `null` for the child's default.
- **Background work:** after the agent's turn, `claude -p` waits for its background subagents and commands, then wakes it for another turn. By default, it kills that work after 10 minutes of idle waiting; Claude runs set `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0` to wait until it ends. Each turn closes with its own `result` event, and the session file keeps every completed response.
- **Resume:** the report and latest relevant session record are read before profile resolution. The same latest record supplies profile, native agent, model, ticket and cwd decisions. Same-agent and active-run guards precede ticket/session-directory side effects and catalog subprocesses. Claude/Codex track expected native IDs from `RunConfig.resume`; a missing or changed identity fails permanently even if later output succeeds. Pi retains its version-3 header and real-cwd guards. No account fallback or replacement conversation is accepted. Agentless legacy sessions remain readable but need a new session.
- **Selection:** `resolveCodeConfig(config, env, { project, explicit, recorded })` returns effective `profile`, agent, normalized launch settings, retained typed quota settings and finalized `childEnv`. New/help/guide/quota precedence is explicit → project → global → automatic resolution. Resume inserts the latest recorded named profile before global resolution. All named selections bypass detection; missing names fail without fallback. No inheritance or profile merging occurs. Automatic resolution detects once: one kind selects a sole matching profile, or its unique `default: true` among several matches, else built-ins when none match. Several unpreferred matches fail with names and selection remedies. No parent permits only a sole total profile; several detected kinds always require a named choice. A per-agent flag never chooses the agent kind.
- **Detection:** only reached when selection needs it. Claude uses `CLAUDECODE=1`, Codex `CODEX_THREAD_ID`, Pi `PI_CODING_AGENT=true` or `AI_AGENT=pi`. Both Pi markers count as one kind. Multiple kinds fail; zero kinds allow singleton inference only for new/help/guide/quota resolution. Native directory variables map through `CONFIG_DIRECTORY_VARIABLES`. Environment/path validation rejects NUL, invalid names, overlapping env/unset and config-directory conflicts.
- **Directory selection:** coding profiles and enabled quota sources accept `configDir?: string | null`. Omitted/undefined inherits the caller's native variable unless `env` or `unset` changes it; otherwise native defaults apply. Strings normalize against the settings directory and supplied home, then set `CLAUDE_CONFIG_DIR`, `CODEX_HOME` or `PI_CODING_AGENT_DIR`. Null remains explicit in loaded/resolved settings and removes only the corresponding variable through the shared environment-construction helper. Both null and strings conflict with that variable in `env`/`unset`. Caller environments and stored `unset` arrays remain unchanged; other path fields stay string-only.
- **Settings boundaries:** `loadConfig` validates structure; launch resolution validates the global reference, duplicate true defaults per agent and selected model defaults. Duplicate defaults fail even with a valid named selection; false and omitted are equivalent. Status reads durable records without loading settings, so malformed or retired settings and dangling profile references never block it. Commands that load settings validate recognized values. Unknown keys at the root, `code`, each profile and each quota object are ignored with `console.warn` on stderr. Profile, environment and alias dictionaries remain dynamic maps. Warnings include escaped property paths with dynamic map names redacted, never values. Direct launch fields and `code.defaultProfiles` are ignored with manual migration guidance; they supply no legacy semantics. The settings file is never rewritten. `json-shape.object` opts into this policy for settings only; project markers retain strict unknown-key rejection. Historical blank or missing profiles read as null and are not rewritten merely to add a field.
- **Discovery isolation:** `main()` creates an executable resolver per command. Catalog caching is additionally scoped by effective environment identity, so repeated programmatic invocations cannot reuse a different profile's installation/PATH. Catalog and injected executable-resolver failures produce fixed diagnostics without native stderr or arbitrary error text, including in the durable completion result. Codex occupancy still requires rollout cumulative totals to match stream totals; lookup uses the selected native environment rather than ambient `CODEX_HOME`. If that environment supplies neither `CODEX_HOME`, `HOME` nor `USERPROFILE`, context is reported unavailable instead of searching the caller's native store.
- **Quota boundary:** `resolveQuotaConfig(code, callerEnv)` returns disabled `source: "none"` or a native `claude`/`codex` source with a finalized environment. Omitted native quota uses `childEnv`; Pi needs an explicit source. An explicit source starts from the original caller environment and applies only quota overrides, its own omitted/null/string directory selection and identity stripping. Coding and explicit-quota resets are isolated; omitted native quota inherits the finalized coding reset. Disabled quota accepts no other recognized fields, including `configDir: null`. It never copies Pi credentials or infers an account from a model. `QuotaReader(source, { cwd, env })` executes only native protocols; CLI presentation handles profile/source labels and disabled/unsupported diagnostics. Reports belong to that CLI's account, without verified pairing to the coding account.

Ordinary developer guidance omits `configDir`; null is a deliberate native-default reset and custom strings remain valid. A string naming the default path still sets the variable. On macOS, setting Claude's default path can select different Keychain credentials from leaving `CLAUDE_CONFIG_DIR` unset. No path comparison, credential copying or account fallback is used. Confirm the intended mode before changing existing selections; a reset leaves HOME, PATH and API-key precedence intact.

OpenClaw deployment inventory instead requires null or a string for every coding profile and enabled explicit quota source. Null resolves to the service home's native default path for filesystem inventory, whose `configDir` output remains an absolute string. Native invocations read selection mode from the named profile/quota settings and unset the variable for null or set the resolved value for a string. Filesystem deduplication cannot collapse these invocation modes. Upgrade the CLI, inventory/policy helpers, settings and runbooks together through controlled maintenance; existing strings are not converted automatically.

### Native Quota Processes

Claude uses the native `/usage` print command and extracts limits before local insights. Its privacy translation operates on a copy of the effective environment. Codex initializes `app-server`, sends `initialized`, then reads `account/rateLimits/read`. A present `rateLimitsByLimitId.codex` is authoritative; malformed named data cannot fall back to legacy `rateLimits`. Legacy identity must be absent, null or `codex`. Valid windows survive independently, with finite percentages in 0–100, positive finite durations and valid nonnegative reset timestamps. Duration determines labels regardless of primary/secondary order.

Both protocols retain the injectable `QuotaProcessAdapter`. The default process runner caps combined stdout/stderr at 1 MiB and the request at 30 seconds. Completion closes stdin, sends TERM and awaits direct-child/pipe closure. After 250 ms it sends KILL, with a further one-second cleanup bound. Failure to discharge ownership is explicit; exit guards remain until ownership ends. Error output is never echoed into diagnostics. This supervises the attached native child, without importing Pi process-tree packages or promising descendant/crash recovery.

### Historical Profile Selection

`ProfileSelection.recorded` preserves three states. Undefined permits new-session inference. A string takes precedence over the global choice, so changed default flags or global settings cannot redirect a named resume. Explicit or actual-cwd project selection may replace a deleted recorded name; global selection and inference cannot rescue it.

Null protects historical unnamed conversations. Explicit/project/global named selection may deliberately replace it. Otherwise the resolver calls legacy parent detection and constructs only that kind's built-ins, ignoring configured profile counts and flags. No or multiple parent kinds still fail. The new record keeps null, and the original transcript stays byte-identical. The recorded agent does not replace detection; existing same-agent and native-identity guards still apply.

Unique-profile inference intentionally changes new-session selection: configured storage, models, environment and permissions that were previously ignored can now apply. This change does not affect the historical-null branch. OpenClaw deployment inventory validates flags and all native stores but still requires explicit `code.profile`; it does not implement automatic resolution.

## Manual Offline Profile Smoke

The named **manual** check runs direct CLI integration against built `alignfirst` and `aligndev` entry points. Prerequisites are installed workspace dependencies, fnm with the repository's Node 26 runtime, Git on PATH, and a POSIX host with executable symlink support. From the repository root:

```sh
fnm exec --using=.nvmrc npm run build
fnm exec --using=.nvmrc npm run test:coding-profiles
```

The command runs [`scripts/coding-profiles-smoke.mjs`](../scripts/coding-profiles-smoke.mjs). It checks profile selection, real CLI reports, linked worktrees, companion placement, resume identity and independent quota routing. Stale settings must warn only on stderr while help, guide, JSON reports and a launch succeed; invalid recognized fields must still fail. Reads preserve the settings bytes. Disposable homes, projects and native CLI shims keep it offline and isolate settings, synthetic identities and process cleanup. Native agents, credentials and providers are not required.

This is CLI integration, not OpenClaw deployment, Docker, conversation or provider acceptance. Run it deliberately; it is outside root `npm test`, CI, release smoke and all test matrices.

## Lightweight Worktrees

`aligndev worktree` dispatches before coding settings, model discovery and project-marker checks. Git's worktree registry is its only inventory, including externally created, detached, missing, locked and prunable entries. `src/worktree/git.ts` parses Git's NUL-delimited output; project status adapts it to its existing report shape. CLI help owns command forms and JSON schemas.

Add validates branch, destination and main-worktree effective plans before Git creation, then applies the shared preparation in `src/worktree/setup.ts`. Setup adopts an existing registered worktree without changing its path, branch, index or Git registration. Without a path, it discovers the current root even from a subdirectory. An explicit path resolves relative to the caller and must be an exact registered root of the same repository. Main and detached worktrees are supported; main setup validates and reports existing directories without creating links or exclusions.

Linked preparation shares usable untracked main-worktree `.plans` and optional `.local` through symlinks, with root-anchored exclusions in shared local Git metadata. It checks HEAD and the index: tracked `.local` stays branch-local with a warning, and project-tracked effective plans fail. Companion plans resolve directly, without a link or exclusion. All required link destinations are checked before writes; conflicting entries and unrelated dirty work remain untouched. Existing links to the expected real target retain their link text. Missing links and exclusions are added idempotently, with links pointing through the main-worktree path so source repairs propagate.

The finished worktree must pass `alignfirst plans check --json`, including linked-worktree parity with the main worktree. Failures retain the branch, worktree and partial preparation, name the failed step and give a quoted setup retry command. Repair the reported problem, then retry setup; no rollback deletes user data.

`src/project/plans.ts` runs `alignfirst plans check --json` and returns `plans.target`. AlignFirst refuses project-tracked effective plans through both logical and resolved paths. From a linked worktree, it requires the same real target and `in` as the main worktree. Separate work-files repositories remain supported; an unused tracked project copy does not block companion plans. New/resumed coding launches apply this gate before stale-session reconciliation, ticket/session writes or model discovery. Historical status, help and inventory remain readable. The playbook's work-files runbook calls `alignfirst plans check`.

The playbook selects documented project workspace tooling first, including non-Node implementations. Without it, the assistant directly orchestrates lightweight list/add/setup/remove, then delegates from the selected path. The `work-files-setup` guide topic is the sole separately authorized companion-preparation recipe and runs before ticket reservation or request capture. The CLI never writes the companion registry or provisions missing plans.

Readiness covers Git and work files only. Install/build/test preparation follows repository commands separately; add/setup manages no ports, environment seeding, infrastructure or application processes. A shared symlink grants no sandbox permissions. Companion access retains existing handling; missing access must be surfaced without silently changing permission policy.

Remove uses ordinary non-force Git removal for one exact linked root. It refuses dirty, locked, main and protected shared-target paths, and any target containing another registered worktree root, even a locked or missing child. It preserves branches and companion registration and never follows shared links for deletion. Stop project activity separately; lightweight removal is not process or infrastructure teardown. External owners such as Paseo can run `npx -y aligndev worktree setup` inside a worktree after creating it and retain ownership of Git deletion. There is no lightweight teardown command or pre-deletion hook: AlignDev has no services, ports or separate registry to release.

## Project Inventory

A projects directory carries a `.alignfirst-projects.json` marker, with an optional description and port ranges:

```json
{
  "description": "Every project is a direct child of ~/projects.",
  "portRanges": [
    { "first": 28000, "last": 28599, "description": "Web projects, exposed through the gateway." },
    { "code": "local", "first": 29000, "last": 29199, "description": "Desktop apps, never exposed." }
  ]
}
```

- A direct child that is a Git main worktree is a project. Its linked worktrees are its workspaces.
- A child directory may be a nested projects directory.
- These are inventory issues: a child outside Git with a root `.alignfirst.json`, and two projects sharing one companion directory. `aligndev project doctor` succeeds only without any issue.
- `list` and `status` carry the registry's independent `aligndev: { profile } | null` selection alongside companion and location data. Inventory reports it without resolving a launch profile or requiring an available coding agent. A missing top-level `aligndev` field in `alignfirst config --json` is an outdated contract and requires an AlignFirst upgrade.
- `--root` defaults to `projectsRoot` in the config, then to the working directory.
- A marker with the old `"portRange": { … }` key is rejected. A project's `.alignfirst.json` keeps its singular `portRange`.

### Port Claims

`aligndev project free-ports --size <n>` returns a free block in a marker range. The size is the project's port range: port names × expected concurrent workspaces. A range without a code is the default; `--range <code>` selects a coded one. The setup guide writes the block as `portRange` in the project's `.alignfirst.json`.
