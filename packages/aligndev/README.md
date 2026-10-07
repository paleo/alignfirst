# aligndev

The AlignFirst Dev Kit CLI. It carries the assistant's playbook, runs a coding agent through [AlignFirst](https://github.com/paleo/alignfirst) protocols, and keeps the inventory of the host's projects and their port ranges. The assistant is an OpenClaw bot, or a coding agent working on one project.

Run `aligndev` through `npx` (`npx -y aligndev …`), or install it with `npm install -g aligndev`. Through `npx`, it runs `alignfirst` through `npx` too, and its help and guides print both commands in that form. A global `aligndev` needs the `alignfirst` CLI on `PATH`: `npm install -g alignfirst`.

Supported systems: Linux and macOS, and Windows through WSL.

## Commands

```sh
aligndev code <command> [<options>]      # run a coding agent through AlignFirst protocols
aligndev project <command> [<options>]   # list projects, check the inventory, claim port ranges
aligndev guide [<topic>]                 # print the playbook and the guides
aligndev --help
aligndev --version
```

Each command prints its own usage with `--help`.

### `aligndev code`

```sh
aligndev code new --protocol spec --ticket AB-123 --message "Feature description"
aligndev code resume <sessionId> --protocol plan
aligndev code new --message "Execute the plan: .plans/AB-123/A2-plan.md"
aligndev code new --protocol aad --no-ticket --message "Task description"
aligndev code new --ticket AB-123 --catchup --protocol aad --message-file message.md
aligndev code status .plans/AB-123/_aligndev/20260829-135529.md
aligndev code quota
```

The coding agent `aligndev code` launches is **the agent**. Run `aligndev code` from the root of the target project. The project must have a `.plans/` directory, in its repository or in its companion directory.

`aligndev code` reads the project's layout from `alignfirst config --json`. Session files go under its `_aligndev` location: `<ticket>/_aligndev/` or `_aligndev/`, below the project's `.plans/` unless the companion holds a separate tree. When some of the project's AlignFirst files exist in its companion, the normal permission modes make the companion writable for the agent (`--add-dir`), and a new session's prompt starts with the `alignfirst context` output.

A new protocol session needs a ticket. `--no-ticket` reserves the next side ticket through `alignfirst ticket --side` and passes it to the agent.

`--catchup` loads the ticket's history (through `alignfirst ticket --catchup`) before the protocol and message. Alone, it returns a short synthesis.

`--message-file <path>` reads the message from a UTF-8 file, or from stdin with `-`. The prompt reaches the agent through stdin.

`aligndev code status` reconciles and shows a run's durable status. It accepts a session file under `_aligndev/` or `<ticket>/_aligndev/` of the `_aligndev` location, or selects the newest run with `--ticket <id>`, `--no-ticket` or `--meta <key>`. If a recorded process is gone, it seals the session file as `status: failed`, `exitReason: terminated`. Linux records also store the process start time to detect pid reuse. Its `contextTokens` line reports what the run left in the agent's context window; a resumed session keeps growing across runs.

`aligndev code quota` shows the selected coding agent's account limits, consumed percentages, and reset times. It works outside a project.

### `aligndev project`

```sh
aligndev project list [--json] [--root <path>]
aligndev project doctor [--root <path>]
aligndev project status <path> [--json] [--root <path>]
aligndev project init [--root <path>] [--description <text>] [--port-range [<code>=]<first>-<last>]...
aligndev project free-ports --size <n> [--range <code>] [--json] [--root <path>]
```

A projects directory groups projects and optional nested projects directories. Its `.alignfirst-projects.json` marker holds an optional description and port ranges. A direct child that is a Git main worktree is a project; linked Git worktrees are listed as its workspaces. A child outside Git with a root `.alignfirst.json` is an inventory issue. `list --json` and `status` report each project's companion directory and the location of its AlignFirst files. Two projects sharing one companion directory is an inventory issue.

```json
{
  "description": "Every project is a direct child of ~/projects.",
  "portRanges": [
    { "first": 28000, "last": 28599, "description": "Web projects, exposed through the gateway." },
    { "code": "local", "first": 29000, "last": 29199, "description": "Desktop apps, never exposed." }
  ]
}
```

`--root` defaults to `projectsRoot` in the config, then to the working directory. `doctor` is a read-only health gate: it succeeds only when discovery completes with no inventory issue.

An older marker carrying `"portRange": { ... }` is rejected; replace the key with `"portRanges": [{ ... }]`. Project configuration in `.alignfirst.json` keeps its singular `portRange` key.

### `aligndev guide`

```sh
aligndev guide [<topic>] [--root <path>]
```

Each topic renders the variant of the configured `platform`.

| Topic | Output | Platforms |
|-------|--------|-----------|
| (none) | The playbook dispatcher. | both |
| `working-session` | The work procedure: a thread under OpenClaw, the conversation for a coding agent. | both |
| `project-workspace-setup`, `consultation` | Runbooks. | both |
| `code` | The delegation guide. | both |
| `channel-handling` | The channel and DM procedure. | `openclaw` |
| `project-lifecycle` | The runbook to create, onboard or remove a project. | `openclaw` |
| `slack-message-tool`, `discord-message-tool` | Extended `message` references. | `openclaw` |
| `project` | The projects guide, followed by the directory sections when the root carries a marker. `--root` overrides `projectsRoot`. | `openclaw` |

Under `openclaw`, the playbook topics require `projectsRoot`.

## Configuration

`aligndev` reads one optional file, `~/.alignfirst/aligndev.config.json`. The path is fixed: no environment variable overrides it. Without it, every key takes its default.

```json
{
  "platform": "openclaw",
  "projectsRoot": "~/projects",
  "code": {
    "agent": "claude",
    "models": ["opus", "sonnet"],
    "skipPermissions": false,
    "unset": ["ANTHROPIC_API_KEY"]
  }
}
```

- `platform` — `openclaw` or `codingAgent` (default). Selects the variant of every `aligndev guide` topic: `openclaw` for an OpenClaw assistant, `codingAgent` for a coding agent acting as the assistant.
- `projectsRoot` — the default projects directory of `aligndev project` and `aligndev guide project`. Required by the `openclaw` playbook. `~/` expands to the home directory; a relative path resolves against the config file's directory.
- `code.agent` — the agent `aligndev code` launches: `claude` or `codex`. Default: the coding agent that runs `aligndev`, detected from the variable it sets on its commands, `CLAUDECODE=1` for Claude Code or `CODEX_THREAD_ID` for Codex. `aligndev code` and `aligndev guide` fail when neither or both are set. `aligndev project` does not need it.
- `code.models` — replaces the selected agent's accepted models.
- `code.skipPermissions` — `true` selects each CLI's dangerous permission-bypass flag. Default: `false`.
- `code.unset` — environment variables stripped from the agent's environment. `aligndev code` always strips the assistant session's identity variables first (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`, …), whatever the agent.

Unknown keys are rejected. An unreadable file, invalid JSON or an invalid value fails every command that loads the config, with an error naming the file.

Companion directories are declared in `~/.alignfirst/companions.json`, which the `alignfirst` CLI reads for both tools. See [its README](https://github.com/paleo/alignfirst/tree/main/packages/alignfirst#companion-directories).

## Execution model

`aligndev code` runs the agent as a direct **foreground** child of its own process. It streams a live transcript to stdout and to a per-run session file, whose frontmatter status goes from `running` to `succeeded` or `failed`, and blocks until the agent exits. It never backgrounds or detaches itself.

Coding runs can be very long, so the caller always runs `aligndev code` as a background task and owns the backgrounding, as `aligndev guide code` prescribes:

- Under OpenClaw, the assistant invokes it through the `exec` tool with `background: true` and `timeoutSeconds: 0`, and chains `openclaw system event --mode now --session-key <key>` onto the command.
- A coding-agent assistant starts it with its own background-execution facility, with no time limit, and outside its sandbox. When the agent wakes the session as the command exits, as Claude Code does, the assistant handles the completion on that wake. Otherwise, the assistant checks its pending runs at the start of the next user turn.

The completion turn locates the session file with `aligndev code status` and reads the result. The session file is the durable result handoff: frontmatter `sessionId` and status, and the `---- Result ----` block.

If `aligndev code` is terminated, its signal handlers seal the session file (`status: failed`, `exitReason: terminated`), then send `SIGTERM` to the agent. After a short grace period, a `SIGKILL` guarantees no orphan is left behind. Only a `SIGKILL` of `aligndev` itself can leave a stale `running` status, which the next `status` call seals.

When the coding agent's session on the host is missing or expired, `aligndev code` detects the authentication failure in its stream, seals the session file with `exitReason: auth_required`, and exits `2` with a one-line stderr message.

## Coding agents

Install the selected CLI and authenticate it on the host: run `claude`, then `/login`, for Claude Code; run `codex login` for Codex.

Normal runs use Claude's `--permission-mode auto` or Codex's `--sandbox workspace-write`.

Claude's default model list is `fable`, `opus`, `sonnet`, `haiku`. Codex's is `astra`, `sol`, `terra`, `luna`; `aligndev code` resolves a selected Codex alias against `codex debug models --bundled`. Set `code.models` to narrow the list or to advertise an explicit Codex slug such as `gpt-5.6-terra`.

Session files record `agent`. A session resumes only with the same selected agent. Agentless legacy sessions stay readable but require a new session.

## The `aligndev` skill

The `aligndev` agent skill makes a Claude Code or Codex session the assistant of the project it runs in. Invoked as `/aligndev` in Claude Code, or `$aligndev` in Codex, it loads the playbook through `npx -y aligndev guide`, which needs `platform: "codingAgent"` in the config. Install it:

```sh
npx skills add https://github.com/paleo/alignfirst --global --skill aligndev
```

The setup guide's [coding-agent assistant reference](https://github.com/paleo/alignfirst/blob/main/skills/alignfirst-setup-guide/references/coding-agent-assistant.md) covers the project, the configuration and the sandbox.

## Port claims

Run `aligndev project free-ports --size <n>` with the block size required by the project's workspace scheme: `perWorkspace × maxWorkspaces`. A marker entry without a code is the default range. Pass `--range <code>` to select a coded range. The setup guide writes the returned block as `portRange` in the project's `.alignfirst.json`.
