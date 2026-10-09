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
| `src/config.ts` | `~/.alignfirst/aligndev.config.json`: schema, defaults, agent detection. |
| `src/code/` | `aligndev code`: arguments, prompt, run, session file, adapters, models, quota. |
| `src/guide/` | `aligndev guide`: topics, the template renderer, and the project's guide file (`guide-file.ts`). |
| `src/project/` | `aligndev project`: discovery, markers, status, port allocation. |
| `templates/guide/` | The playbook and guides, rendered per platform. |

Templates use `{{ALIGNDEV}}`, `{{ALIGNFIRST}}` placeholders for the command forms. Under `npx`, both commands print as `npx -y …`. Variants sit in blocks, each marker alone on its line:

- A platform block, `{{#openclaw}}` or `{{#codingAgent}}`, sits at the top level.
- A condition block, `{{#developers}}`, `{{#readme}}` or `{{#noGuide}}`, sits directly inside a `{{#codingAgent}}` block and holds text only.

The condition names the project's guide file for the assistant. Under `codingAgent`, `aligndev guide` resolves it once per call, before rendering a playbook topic: it runs `alignfirst config --json` in the working directory, and a report error fails the command. `DEVELOPERS.md` at its reported location gives `developers`; otherwise `README.md` at the root of the working directory's repository gives `readme`; otherwise, outside git included, `noGuide`. OpenClaw rendering and the `code` topic read no report.

## Running the Agent

`aligndev code` runs the agent as a direct **foreground** child. It streams a live transcript to stdout and to a per-run session file, and blocks until the agent exits. It never backgrounds or detaches itself: coding runs are long, so the caller backgrounds the command, as `aligndev guide code` prescribes.

- Under OpenClaw, the assistant runs it through `exec` with `background: true` and `timeoutSeconds: 0`, and chains `openclaw system event --mode now --session-key <key>` onto the command.
- A coding-agent assistant uses its own background execution, with no time limit and outside its sandbox. Claude Code wakes the session when the command exits. Otherwise, the assistant checks its pending runs at the start of the next user turn.

The prompt reaches the agent through stdin. The agent inherits the caller's environment, minus the assistant session's identity variables (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`, …) and the configured `code.unset`.

### Session File

The session file is the durable handoff of a run. Its frontmatter holds `agent`, `sessionId`, `status` (`running`, then `succeeded` or `failed`) and an optional `exitReason`; a `---- Result ----` block closes it. The completion turn finds it with `aligndev code status`.

Session files live under the project's `_aligndev` location, read from `alignfirst config --json`: `<ticket>/_aligndev/`, or `_aligndev/` without a ticket. That location is below the project's `.plans/`, unless a companion directory holds a separate tree.

When some of the project's AlignFirst files live in its companion, the normal permission modes make the companion writable (`--add-dir`), and a new session's prompt starts with the `alignfirst context` output. See [Companion Directories](companion-directories.md).

### Termination and Status

If `aligndev code` is terminated, its signal handlers seal the session file (`status: failed`, `exitReason: terminated`), then send `SIGTERM` to the agent and, after a short grace period, `SIGKILL`. No orphan survives.

Only a `SIGKILL` of `aligndev` itself leaves a stale `running` status. `aligndev code status` checks that the recorded pid still runs; on Linux, the recorded process start time also detects pid reuse. A dead run is sealed as `terminated` before the report. The `contextTokens` line reports what the run left in the agent's context window; a resumed session keeps growing.

### Authentication

When the agent's login on the host is missing or expired, `aligndev code` detects the failure in the agent's stream, seals the session file with `exitReason: auth_required`, and exits `2` with a one-line message. The guide tells the assistant to report it, never to retry.

### Tickets

A new protocol session needs a ticket. `--no-ticket` reserves the next side ticket through `alignfirst ticket --side`. `--catchup` loads the ticket's history through `alignfirst ticket --catchup` before the protocol and message.

## Coding Agents

An adapter (`claude-agent.ts`, `codex-agent.ts`) builds each CLI's arguments, parses its stream, and recognizes its authentication errors.

- **Permissions:** normal runs use Claude's `--permission-mode auto` or Codex's `--sandbox workspace-write`. `code.skipPermissions` selects each CLI's bypass flag.
- **Models:** Claude's defaults are `fable`, `opus`, `sonnet`, `haiku`; Codex's are `astra`, `sol`, `terra`, `luna`. A selected Codex alias resolves to the newest matching slug of `codex debug models --bundled`. `code.models` replaces the list.
- **Resume:** session files record `agent`, and a session resumes only with the same agent. Agentless legacy sessions stay readable but need a new session.
- **Detection:** without `code.agent`, the agent is the one that runs `aligndev`: Claude Code sets `CLAUDECODE=1` (documented), Codex sets `CODEX_THREAD_ID` (from its source). Neither or both is an error, raised only by the commands that need the agent: `guide code`, `code --help`, `code quota`, and `code new` or `resume`.

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

`aligndev project free-ports --size <n>` returns a free block in a marker range. The size is the project's workspace scheme: `perWorkspace × maxWorkspaces`. A range without a code is the default; `--range <code>` selects a coded one. The setup guide writes the block as `portRange` in the project's `.alignfirst.json`.
