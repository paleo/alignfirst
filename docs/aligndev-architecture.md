---
title: aligndev Architecture
summary: How `aligndev` works internally — the foreground run and its session file, termination and authentication handling, coding-agent adapters, the project inventory and port claims.
read_when:
  - onboarding to the aligndev codebase
  - changing how `aligndev code` launches, tracks or terminates a coding agent
  - changing session files, `aligndev code status` or the `_aligndev` location
  - changing the project inventory, its marker or port claims
  - adding a coding agent
---

# aligndev Architecture

`aligndev` is the CLI an assistant uses: it prints the playbook (`guide`), delegates work to a coding agent (`code`), and inventories the host's projects (`project`). Its users are agents, so its `--help` and guides are the user reference. This document covers what they leave out. The [README](../packages/aligndev/README.md) covers setup and configuration.

## Source Structure

| Path | Responsibility |
| --- | --- |
| `src/cli.ts` | Entry point: dispatches the command, loads the config, resolves the coding agent. |
| `src/config.ts` | `~/.alignfirst/aligndev.settings.json`: schema, defaults, agent detection. |
| `src/code/` | `aligndev code`: arguments, prompt, run, session file, adapters, models, quota. |
| `src/guide/` | `aligndev guide`: topics, the template renderer, and the project's guide file (`guide-file.ts`). |
| `src/project/` | `aligndev project`: discovery, markers, status, port allocation. |
| `templates/guide/` | The playbook and guides, rendered per platform. |

Templates use `{{ALIGNDEV}}`, `{{ALIGNFIRST}}` placeholders for the command forms. Under `npx`, both commands print as `npx -y …`. Variants sit in blocks, each marker alone on its line:

- A platform block, `{{#openclaw}}` or `{{#codingAgent}}`, sits at the top level.
- A condition block, `{{#developers}}`, `{{#readme}}`, `{{#noGuide}}` or `{{#hasGuide}}` (both guide files), sits directly inside a `{{#codingAgent}}` block and holds text only.

The condition names the project's guide file for the assistant. Under `codingAgent`, `aligndev guide` resolves it once per call, before rendering a playbook topic: it runs `alignfirst config --json` in PROJECT_PATH, the main worktree of the working directory, and a report error fails the command. `DEVELOPERS.md` at its reported location gives `developers`; otherwise `README.md` at the root of PROJECT_PATH gives `readme`; otherwise, outside git included, `noGuide`. OpenClaw rendering and the `code` topic read no report.

## Running the Agent

`aligndev code` runs the agent as a direct **foreground** child until it exits. It writes the transcript to a durable per-run file and, unless `--quiet` is given, streams it to stdout. Quiet mode keeps the initial `Session file:` line, new child `Session ID:` and failure diagnostics. The CLI never backgrounds or detaches itself.

- Under OpenClaw, the assistant runs it through `exec` with `background: true` and `timeoutSeconds: 0`, and chains `openclaw system event --mode now --session-key <key>` onto the command.
- Claude Code/Codex parents retain their established background facilities and sandbox elevation. Claude Code wakes the parent on exit; where no completion bridge is configured, Codex uses the next-user-turn status fallback. Pi work does not certify or replace these integrations.
- A persistent Pi parent uses the generic `background` tool to launch an ordinary quoted CLI command with `--quiet` and a unique per-run `--meta`. The guide owns those flags, not the extension. A notice triggers a handle-ownership check, then exact-file or unique-key `status --result` retrieval from the original worktree. Parent host and child adapter are independent. See [Pi Extensions](pi-extensions.md) for package and native delivery boundaries.

The prompt reaches the agent through stdin. A new session's prompt opens with a run context. It tells the agent that ending its turn kills its subagents and background commands, so it must wait for them first. The agent inherits the caller's environment, minus the assistant session's identity variables (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`, …) and the configured `code.unset`.

### Session File

The session file is the durable handoff of a run. Its frontmatter holds `agent`, `sessionId`, `status` (`running`, then `succeeded` or `failed`) and an optional `exitReason`; a `---- Result ----` block closes it. The completion turn finds it with `aligndev code status`.

Session files live under the project's `_aligndev` location, read from `alignfirst config --json`: `<ticket>/_aligndev/`, or `_aligndev/` without a ticket. That location is below the project's `.plans/`, unless a companion directory holds a separate tree.

The CLI creates a missing companion before launch, independently of permission mode. Claude Code/Codex normal modes add it through `--add-dir`; Pi uses ordinary OS access. When some AlignFirst files live there, a new session's prompt starts with `alignfirst context`. See [Companion Directories](companion-directories.md).

`status` accepts exactly one file, `--ticket`, `--no-ticket`, or `--meta` selector. Scope/key selectors choose the newest matching active run, so asynchronous callers use a unique key per run and retain the resolved exact path. `status --result` adds the terminal Result block when present, without transcript output; running runs show metadata only. It has no numeric final-text cap. `readCompletion` currently reads the whole file into memory. A successful status query exits `0` even when the run failed; launch/run exits are `0` for success, `1` for ordinary failure and `2` for authentication.

### Termination and Status

On handled termination, the CLI seals the session file (`status: failed`, `exitReason: terminated`), sends `SIGTERM` to its child, and escalates to `SIGKILL` after its two-second grace. The parent host owns attached process-tree supervision; this does not promise crash-proof descendant cleanup.

Abrupt host loss, a crash or `SIGKILL` can leave a stale `running` status. `aligndev code status` checks that the recorded pid still runs; on Linux, the recorded process start time also detects pid reuse. A dead run is sealed as `terminated` before the report. The `contextTokens` line reports what the run left in the agent's context window; a resumed session keeps growing.

### Authentication

When the agent's login on the host is missing or expired, `aligndev code` detects the failure in the agent's stream, seals the session file with `exitReason: auth_required`, and exits `2` with a one-line message. The guide tells the assistant to report it, never to retry.

### Tickets

A new protocol session needs a ticket. `--no-ticket` reserves the next side ticket through `alignfirst ticket --side`. `--catchup` loads the ticket's history through `alignfirst ticket --catchup` before the protocol and message. A protocol run is refused while another protocol run is active in the same worktree or on the same ticket, since `alignfirst ticket --next` reserves no work-file prefix. Runs without a protocol neither block nor are blocked.

## Coding Agents

Three adapters (`claude-agent.ts`, `codex-agent.ts`, `pi-agent.ts`) build CLI arguments, parse streams and recognize authentication failures. Pi targets 1.3.0's JSON/print settlement contract, preserves its native conversation for resume, and requires that resume use the recorded directory. The synchronous subagent package is optional in that child environment; it is not an adapter dependency.

- **Permissions:** normal runs use Claude's `--permission-mode auto` or Codex's `--sandbox workspace-write`. `code.skipPermissions` selects their bypass flags. Pi uses ordinary OS permissions and saved project trust, without forced approval; that setting has no effect on Pi.
- **Models:** Claude's defaults are `fable`, `opus`, `sonnet`, `haiku`; Codex's are `astra`, `sol`, `terra`, `luna`. A selected Codex alias resolves through `codex debug models --bundled`. Pi accepts nonblank native selectors unchanged, preferably `provider/model` with optional thinking suffix, without a finite default allowlist. A nonempty `code.models` replaces the accepted list. Without `--model`, new sessions use `code.defaultModel`, else the child's default; resumes keep their latest recorded model unchecked against the current list. The file records the chosen name, or `null` for the child's default. Pi quota is unsupported.
- **Background work:** after the agent's turn, `claude -p` waits for its background subagents and commands, then wakes it for another turn. By default, it kills that work after 10 minutes of idle waiting; Claude runs set `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0` to wait until it ends. Each turn closes with its own `result` event, and the session file keeps the last non-empty one.
- **Resume:** session files record `agent`, and a session resumes only with the same agent. Agentless legacy sessions stay readable but need a new session.
- **Detection:** without `code.agent`, Claude Code is identified by `CLAUDECODE=1`, Codex by `CODEX_THREAD_ID`, and Pi by `PI_CODING_AGENT=true` or `AI_AGENT=pi`. Zero or multiple detected kinds is an error only on agent-dependent commands: `guide code`, `code --help`, `code quota`, and `code new/resume`. Explicit `code.agent` wins over all markers. It selects a child, never a parent launch tool.

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
- `--root` defaults to `projectsRoot` in the config, then to the working directory.
- A marker with the old `"portRange": { … }` key is rejected. A project's `.alignfirst.json` keeps its singular `portRange`.

### Port Claims

`aligndev project free-ports --size <n>` returns a free block in a marker range. The size is the project's port range: port names × expected concurrent workspaces. A range without a code is the default; `--range <code>` selects a coded one. The setup guide writes the block as `portRange` in the project's `.alignfirst.json`.
