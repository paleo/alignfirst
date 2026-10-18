# Pi Background

Run non-interactive shell jobs through one `background` tool. Start returns an opaque handle after OS spawn acknowledgement. Pi can continue the conversation while the command runs. Natural completion requests a native follow-up turn in an ordinary idle or busy session.

This package works independently of any project tooling and of the subagent extension.

## Install

```sh
pi install npm:@alignfirst/pi-background
```

Requires Node.js 22.19.0 or later. Tested with **Pi 1.3.0**, **Node 26.8.1 / 22.23.3**, and **Linux**. The exact Node 22.19.0 floor has not been exercised. macOS and Windows through WSL are supported targets but have not been exercised here. Native Windows is refused before process launch. Host peer ranges are `*` under Pi's package rules; they do not certify future Pi versions.

Loading the extension starts no process or timer. Installation and loading do not install profiles, skills, or the other extension.

## Actions

Examples below are arguments to the `background` tool.

Start a build:

```json
{"action":"start","command":"npm run build","cwd":"./app","label":"build"}
```

Start a test run:

```json
{"action":"start","command":"npm test","label":"tests"}
```

The default cwd is the active Pi cwd. Relative paths resolve against it. The tool uses Pi's public `getShellConfig()` and honors `shellPath`; it passes the command literally as the final shell argument. It does not apply `shellCommandPrefix`. Shell quoting and expansion remain the caller's responsibility. Ordinary environment variables and credentials are inherited. The five `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, and `PI_REASONING_LEVEL` values are derived from the current launch context; absent values remove inherited metadata. The process markers identify Pi as the parent, including in SDK hosts.

Stdin is closed. There is no interactive input interface or default execution timeout. An unknown command reported by a successfully started shell is a failed job; failure to spawn the shell is a tool error.

| Action | Fields | Result |
| --- | --- | --- |
| `start` | Required nonblank `command`; optional `cwd`, `label` | `{ action, job }` after spawn acknowledgement. An instant exit may already be terminal. |
| `list` | None | `{ action, jobs }` with metadata only. |
| `status` | `id` | `{ action, job }`; a failed job is a successful status query. |
| `output` | `id`; optional integer `maxBytes` | `{ action, job, output, returnedBytes, outputBytes, retainedBytes, truncated }`. |
| `stop` | `id` | `{ action, job }` after owned process cleanup. Repeated calls share cleanup; terminal calls return existing state. |
| `clear` | `id` of a terminal job | `{ action, id, cleared: true }`. Releases that record and its output. |

Unknown fields and fields belonging to another action are refused. Handles are UUIDs, never arbitrary PIDs. Unknown, cleared, retired, and foreign handles are errors.

For example, read output and stop a still-running job:

```json
{"action":"output","id":"c710e799-2adf-4e40-a514-51a26bdd3631","maxBytes":16384}
```

```json
{"action":"stop","id":"c710e799-2adf-4e40-a514-51a26bdd3631"}
```

### Results and bounds

Every successful result has matching textual JSON, `structuredContent`, and bounded `details`, with a declared `outputSchema`.

A `job` has `id`, `command`, absolute `cwd`, optional `label`, `status`, ISO `startedAt`, optional ISO `finishedAt`, available `exitCode`/`signal`, optional bounded `error`, and `outputBytes`, `retainedBytes`, `truncated`. Status is `running`, `succeeded`, `failed`, or `cancelled`. Commands above 256 bytes, labels above 128 bytes, and cwd above 512 bytes use explicitly marked `…[preview]` metadata. Complete strings are not hidden in details. Error diagnostics are bounded to 512 bytes plus their marker/prefix.

- Maximum **eight live jobs**, including startup reservations and incomplete cleanup.
- Maximum **32 retained records**. Capacity is reserved before asynchronous startup. Clear terminal records explicitly; no record is automatically evicted.
- Input limits: command **64 KiB**, cwd **4,096 bytes**, label **256 bytes**. Supplied strings must be nonblank and NUL-free.
- Output storage: **1 MiB per job**, shared between stdout and stderr, including oversized chunks.
- Output reads: newest **16 KiB** by default; `maxBytes` accepts **1–51,200**. Terminal controls are removed before display. `returnedBytes` counts the sanitized text.
- `outputBytes` counts observed raw bytes. `retainedBytes` counts stored decoded UTF-8 bytes. `truncated` reports discarded output, including a shortened read. Incomplete UTF-8 sequences are held independently per stream until decodable. Display tails begin on a UTF-8 boundary.

Combined output follows observed decoded arrival order. Stdout and stderr do not supply a shared chronological order. Status/list omit logs. Output is ephemeral, with no persistent log directory or full-output-path promise. Redirect output explicitly when a durable artifact is needed:

```json
{"action":"start","command":"npm test > test-results.log 2>&1","label":"durable test output"}
```

## Completion and ownership

After acknowledging a launch, end the parent turn instead of polling. On natural success or failure, the extension makes one native `sendMessage` attempt with `triggerTurn: true` and `deliverAs: "followUp"`. This requests an idle turn or follows active work. It is not a receipt that a model consumed the notice.

A completion notice contains bounded untrusted metadata: handle, originating session/runtime/generation, label, cwd, and terminal outcome. It omits the full command and logs. **Validate the handle with `status` before acting. Ignore unknown/retired handles and notices from an inactive origin.** Use `output` only when logs are needed.

| Event | Jobs and notices |
| --- | --- |
| Ordinary parent turn ends | Accepted jobs continue. Ordinary idle completion requests another turn; busy completion follows current work. |
| Parent interruption after launch acknowledgement | Accepted jobs continue. Native queued delivery can be interrupted. |
| Launch interrupted before acknowledgement | Created work is stopped; an unsuccessful launch produces no completion turn. |
| Explicit `stop` | Cancellation intent precedes signals; successful cleanup reports `cancelled` without a new completion turn. |
| Manual standalone compaction | Jobs continue. Completions are held locally and may wait for a later ordinary user turn, even after compaction ends. |
| Automatic compaction inside an observed active run | Uses the ordinary native follow-up route. A busy context without an observed run is guarded conservatively. |
| Tree picker opened/cancelled without navigation | No job cancellation. |
| Navigation begins | New notice submissions are suspended; jobs continue during summary generation. |
| Navigation succeeds at another point | Old branch jobs are stopped; old handles and unsent notices are retired. |
| Navigation fails or is cancelled after its pre-event | Jobs remain owned. Held notices can wait for a later ordinary user turn. Pi has no public navigation-end event for these outcomes. |
| Quit, new, resume, fork, or reload | Owner is invalidated, unsent notices discarded, and jobs stopped concurrently. No reconstruction or adoption occurs. |
| Explicit `clear` | Removes only a terminal record and its unsent local notice. |

A later ordinary user turn can receive retained local notices as context without requesting another turn. The batch is bounded to 24 KiB. There is no polling, retry timer, acknowledgement protocol, persistence, or autonomous replay guarantee. A second completion after that recovery turn regains ordinary native handoff.

**Pi owns an already-submitted notice.** A native follow-up can survive interruption, `/tree`, or `/reload` and appear later in another active branch. The extension cannot selectively withdraw it or prevent its turn. `stop`, `clear`, and teardown do not retract it. The extension never rewrites Pi's queues. Explicit native queue clearing can instead remove a notice permanently; the extension does not recreate it.

Lifecycle handlers run sequentially across extensions. A completion while an earlier asynchronous shutdown handler is held can still be submitted by this extension's active owner. Once this extension's shutdown handler invalidates that owner, late callbacks submit nothing. Submitted notices retain the origin described above.

A one-shot Pi process is not a persistent assistant. It exits and cleans up its jobs rather than remaining alive for completion reporting.

## Process cleanup and permissions

Jobs share Pi's operating-system permissions, filesystem, credentials, and network. This is not a sandbox. Keep work attached: do not use `nohup`, daemonization, or detachment to outlive the owner. There is no external-PID adoption.

Cancellation starts immediately with TERM. Owned survivors receive KILL after one five-second graceful window, allowing cooperative nested tools to clean up first. Direct-child reaping and pipe draining are separately bounded. Independent jobs stop concurrently; another extension's handler can be awaited separately by Pi.

A cleanup failure leaves the job `running` with an explicit error, occupying live capacity and refusing `clear`. A later explicit `stop` can retry. A launch whose cancellation cleanup fails reports its retained handle as an error. New launches are refused while lifecycle cleanup remains incomplete in the active runtime. Natural shell exit also cleans remaining owned work before finalization, preserving the shell's actual exit outcome.

Linux cleanup verifies process-start identities before signalling. macOS uses process-table start identities; that path remains untested here. Strict cleanup after `kill -9`, host crashes, machine failure, or deliberately escaped daemons is outside the guarantee.

## Maintainer checks

```sh
npm test --workspace @alignfirst/pi-background
npm run typecheck --workspace @alignfirst/pi-background
npm run build --workspace @alignfirst/pi-background
npm run lint --workspace @alignfirst/pi-background
npm pack --workspace @alignfirst/pi-background --dry-run --json
```

`test/process-tree.test.ts` exercises real descendants, TERM resistance, separate groups, retained pipes, actual Pi/bash cleanup, parent shutdown, query failure/retry, and reaping. `test/lifecycle.test.ts` uses Pi's public session runtime and a local scripted provider to exercise scheduling and replacement. `test/tool.test.ts` covers public actions, startup/cancellation races, capacity, cleanup failures, and output limits. Deterministic tests require no external model or network request. `test/aligndev-integration.test.ts` adds real CLI subprocess tests through the packed extension; this is a test dependency only. Repository `npm run release:smoke` verifies standalone packed installs without either CLI. Opt-in Terra and real terminal lifecycle checks are documented in [Pi Extensions](../../docs/pi-extensions.md#checks).

The package-local `src/process-tree.ts` deliberately duplicates the small cleanup leaf from `pi-subagent`; propagate generic cleanup fixes and their conformance cases to both packages. Neither package imports the other at runtime.

MIT. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
