# @alignfirst/pi-subagent

Run synchronous Pi subagents with separate contexts. The package registers one tool, `subagent`, and includes a generic `worker`. It needs neither AlignFirst nor AlignDev.

## Install

Requires Pi 1.3.0 and Node.js 22.19 or newer. Linux is exercised by this package's subprocess tests on Node 26.8.1 and 22.23.3. The exact Node 22.19.0 floor has not been exercised. macOS support uses the Unix process-table implementation but has not been exercised here. WSL uses the Linux path; native Windows is rejected before launch.

If an existing local extension already registers `subagent`, disable it explicitly with `pi config` before installing this replacement. This includes a local `~/.pi/agent/extensions/subagent` example or symlink. Keep your profiles; this package does not overwrite them. Do not load both implementations.

```sh
pi install npm:@alignfirst/pi-subagent
```

Reload Pi after changing extensions. `/reload` cancels running subagents. No other extension package is required.

The sole Pi extension entry, root `index.js`, forwards the default factory from compiled `dist/index.js`. Pi displays the npm package label without `:dist`. Loading starts no process or timer.

## Three modes

Use exactly one mode. An omitted `agent` selects the bundled `worker`.

```json
{"task":"Inspect the parser and report its edge cases."}
```

```json
{"tasks":[{"task":"Review validation."},{"task":"Review error handling.","model":"provider/model-id","thinking":"low"}]}
```

```json
{"chain":[{"task":"Identify the smallest fix."},{"task":"Implement this proposal: {previous}"}]}
```

- Single accepts `task`, optional `agent` and `cwd`.
- Parallel accepts a nonempty `tasks` list, with at most eight assignments. Four children run concurrently. Results remain in input order; failures preserve successful siblings.
- Chain accepts a nonempty `chain` list. Each step can substitute the preceding final answer with `{previous}`. It stops on failure or cancellation. A predecessor exceeding the 48 KiB handoff limit stops the chain; display-only truncation is reported separately.

Collection entries accept `task`, optional `agent`, `cwd`, `model`, and `thinking`. Top-level `model`, `thinking`, and `agentScope` apply in all modes. Blank tasks, names and models, mixed modes, and unknown fields are errors. A relative cwd resolves from the parent's cwd; it changes execution, not profile discovery.

Model precedence is task override → top-level override → profile model → parent provider/model. Thinking precedence is task override → top-level override → parent thinking, independently of model. Thinking accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; Pi may clamp it to the model's capabilities. Settings are snapshotted at dispatch. Model selectors pass directly to Pi.

## Profiles and trust

The worker uses `read`, `bash`, `edit`, and `write`. Its generic prompt asks the child to follow the assignment and project instructions and report checks and blockers. No home-directory setup is needed.

Optional profiles are Markdown files with frontmatter:

```markdown
---
name: reviewer
description: Review a proposed change
tools: [read, grep, find, ls]
model: provider/model-id
---
Review the assignment. Report concrete findings and remaining uncertainty.
```

`tools` also accepts a comma-separated string. If supplied, it must be a nonempty list of valid tool names or patterns; malformed restrictions fail when that profile is requested. Omitting it leaves Pi's configured tool defaults in effect. Explicit lists exclude unlisted MCP tools too. To allow MCP tools, name their `mcp__…` entries explicitly. These restrictions control Pi's tool loadout, not operating-system access.

Profiles are discovered once per call:

| `agentScope` | Sources, in override order |
| --- | --- |
| `user` (default) | Bundled worker, then `<agent-dir>/agents/*.md` |
| `project` | Bundled worker, then the nearest parent-project `.pi/agents/*.md` |
| `both` | Bundled worker, then user, then project profiles |

`<agent-dir>` follows Pi's configured agent directory (`PI_CODING_AGENT_DIR`, normally `~/.pi/agent`). Project scope requires the parent context's established project trust, including in headless mode. Review the project and establish trust with `/trust` first. Pi auto-trusts a folder containing only `.pi/agents` because it does not recognize that directory as a protected resource. In that case this extension additionally requires a saved positive trust decision; implicit startup trust is insufficient. Host-gated resources are checked at session startup, so creating a settings file during a turn cannot manufacture approval. There is no model-controlled confirmation bypass or interactive child prompt. Duplicate names within one source and malformed requested profiles fail with their file path.

Children retain normal Pi discovery in their execution directory. A different task cwd has its own project-trust decision; this package never adds `--approve`. Credentials and storage/configuration variables survive, while inherited parent session/model metadata is cleared.

## Results and limits

Each child is an installed Pi CLI process in JSON/print mode with `--no-session`. The extension resolves the host package's declared Pi executable entry; it never relaunches an arbitrary SDK application's entry script. No child session is persisted, parent transcript copied, or transient parent system prompt inherited. The profile prompt is appended to Pi's normal prompt. The assignment is stdin data inside a fixed `Task:` envelope and footer, preserving its bytes, including trailing whitespace, without interpreting a leading slash command or shell syntax.

A result contains `mode` and ordered `results`. Each task reports `agent`, `agentSource`, resolved `cwd`, available `model` and `thinking`, `status` (`succeeded`, `failed`, or `cancelled`), available `exitCode`/`signal`, `output`, `truncated`, bounded `error`, and `usage`. The same data is available as `structuredContent` and tool details. Any task failure/cancellation marks the aggregate tool result as an error. Nested model usage is also reported through Pi's native tool-result `usage` field.

Success requires a valid session header, an authoritative successful final assistant response, non-aborted `agent_settled`, and exit zero. `agent_end`, partial text, or a zero exit alone is insufficient. A later successful response can recover a provider error; malformed protocol stays fatal. A model length-limit stop is a failure, independently of display truncation.

Model-facing content totals at most 50 KiB, including headings and diagnostics. Retained answer text totals at most 40 KiB per invocation, with at most 8 KiB of diagnostics. Per-child parsing retains at most 48 KiB of final answer text and rejects protocol records above 1 MiB. Result metadata above 128 KiB is rejected before launch; finalized usage identities are bounded. Chain handoffs use the complete bounded predecessor answer before display allocation. Truncation is marked; omitted text has no hidden full-output artifact. For larger deliverables, ask the child to write an explicit project file and return its path.

## Filesystem and process ownership

Children share the filesystem and account permissions. They are not a sandbox. Do not use `nohup`, daemonization, or detachment to outlive an assignment. There is no background mode, persistent session, resume, inter-agent messaging, or automatic worktree.

Per-call abort stops synchronous children and awaits every running parallel sibling. Session shutdown/replacement, reload, and successful tree navigation retire the old owner before cleanup. Opening or cancelling a tree picker does not itself cancel work. Late launch preparation and callbacks cannot become work for a replacement owner. Teardown also awaits live calls, including pending launch preparation and prompt-file cleanup.

Managed launches use an owned Unix process group without `unref()`. Cleanup takes process-table snapshots (from `/proc` on Linux, `ps` on macOS), retains discovered descendant identities/groups across leader exit, sends TERM, refreshes descendants at escalation, and force-kills survivors after a shared five-second graceful deadline. Direct-child exit and drained pipes are awaited separately with bounded failure reporting. Linux checks `/proc` start times before later signals; macOS snapshots compare `ps` start times. Zombies are terminal, and the direct child is reaped. Pi's own print-mode signal handling can force-kill its tracked bash groups during grace, so descendants are not each promised five seconds.

Process-query failures and unconfirmed survivors are cleanup errors. Unresolved ownership remains in the active extension runtime for a fresh cleanup attempt. These guarantees cover ordinary attached work observable at cleanup boundaries and retained process groups; they do not provide crash recovery or supervision of deliberately escaped daemons. Strict cleanup after `kill -9`, machine failure, or runtime crashes is outside this version.

## Development

From the repository root, using the repository's Node version:

```sh
fnm exec --using=.nvmrc npm test --workspace @alignfirst/pi-subagent
fnm exec --using=.nvmrc npm run typecheck --workspace @alignfirst/pi-subagent
fnm exec --using=.nvmrc npm run build --workspace @alignfirst/pi-subagent
fnm exec --using=.nvmrc npm run lint --workspace @alignfirst/pi-subagent
```

Tests include real descendant trees, TERM-ignoring and separately grouped children, natural leader exit with inherited/closed pipes, descendants created during grace, an actual Pi child running bash, a deterministic headless Pi parent invoking parallel subagents, saved-trust/refusal cases, actual SDK reload, and an actual Pi parent shutdown with nested Pi/bash work. They make no external model calls. Repository `npm run release:smoke` verifies standalone packed installs, independently and alongside the background package. Opt-in Terra checks, including a headless parent delegating single/parallel assignments, are documented in [Pi Extensions](../../docs/pi-extensions.md#checks).

MIT. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md) for the Pi example attribution.
