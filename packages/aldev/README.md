# aldev

The AlignFirst Dev Kit CLI. It carries the assistant's playbook, runs a coding agent through [AlignFirst](https://github.com/paleo/alignfirst) protocols, and keeps the inventory of the host's projects and their port ranges.

Prerequisite: install the `alignfirst` CLI on `PATH` with `npm install -g alignfirst`.

Install `aldev` with `npm install -g aldev`.

## Commands

```sh
aldev code <command> [<options>]      # run a coding agent through AlignFirst protocols
aldev project <command> [<options>]   # list projects, check the inventory, claim port ranges
aldev guide [<topic>]                 # print the playbook and the guides
aldev --help
aldev --version
```

Each command prints its own usage with `--help`.

### `aldev code`

```sh
aldev code new --protocol spec --ticket AB-123 --message "Feature description"
aldev code resume <sessionId> --protocol plan
aldev code new --message "Execute the plan: .plans/AB-123/A2-plan.md"
aldev code new --protocol aad --no-ticket --message "Task description"
aldev code new --ticket AB-123 --catchup --protocol aad --message-file message.md
aldev code status .plans/AB-123/_aldev/20260829-135529.md
aldev code quota
```

The coding agent `aldev code` launches is **the coder**. Run `aldev code` from the root of the target project. The project must have a `.plans/` directory, in its repository or in its companion directory.

`aldev code` reads the project's layout from `alignfirst config --json`. Session files go under its `_aldev` location: `<ticket>/_aldev/` or `_aldev/`, below the project's `.plans/` unless the companion holds a separate tree. When the project's AlignFirst files live in its companion, the normal permission modes make the companion writable for the coder (`--add-dir`), and a new session's prompt starts with the `alignfirst context` output.

A new protocol session needs a ticket. `--no-ticket` reserves the next side ticket through `alignfirst ticket --side` and passes it to the coder.

`--catchup` loads the ticket's history (through `alignfirst ticket --catchup`) before the protocol and message. Alone, it returns a short synthesis.

`--message-file <path>` reads the message from a UTF-8 file, or from stdin with `-`. The prompt reaches the coder through stdin.

`aldev code status` reconciles and shows a run's durable status. It accepts a session file under `_aldev/` or `<ticket>/_aldev/` of the `_aldev` location, or selects the newest run with `--ticket <id>`, `--no-ticket` or `--meta <key>`. If a recorded process is gone, it seals the session file as `status: failed`, `exitReason: terminated`. Linux records also store the process start time to detect pid reuse. Its `contextTokens` line reports what the run left in the coder's context window; a resumed session keeps growing across runs.

`aldev code quota` shows the selected coding agent's account limits, consumed percentages, and reset times. It works outside a project.

### `aldev project`

```sh
aldev project list [--json] [--root <path>]
aldev project doctor [--root <path>]
aldev project status <path> [--json] [--root <path>]
aldev project init [--root <path>] [--description <text>] [--port-range [<code>=]<first>-<last>]...
aldev project free-ports --size <n> [--range <code>] [--json] [--root <path>]
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

### `aldev guide`

```sh
aldev guide [<topic>] [--root <path>]
```

| Topic | Output | Requires |
|-------|--------|----------|
| (none) | The playbook dispatcher. | `platform`, `projectsRoot` |
| `channel-handling`, `working-session` | Surface procedures. | `platform`, `projectsRoot` |
| `project-workspace-setup`, `project-lifecycle`, `consultation` | Runbooks. | `platform`, `projectsRoot` |
| `slack-message-tool`, `discord-message-tool` | Extended `message` references. | `platform`, `projectsRoot` |
| `code` | The delegation guide: the OpenClaw variant when `platform` is `openclaw`, the generic one otherwise. | `code.agent` |
| `project` | The projects guide, followed by the directory sections when the root carries a marker. `--root` overrides `projectsRoot`. | — |

## Configuration

`aldev` reads one file, `~/.config/alignfirst/aldev.config.json`. The path is fixed: no environment variable overrides it. An absent file means no configuration, and each command then fails on the first key it needs.

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

- `platform` — selects the playbook of `aldev guide` and the variant of `aldev guide code`. Accepted value: `openclaw`.
- `projectsRoot` — the default projects directory. `~/` expands to the home directory; a relative path resolves against the config file's directory.
- `code.agent` — the coding agent: `claude` or `codex`. Required by every `aldev code` command except `status`, and by `aldev guide code`.
- `code.models` — replaces the selected agent's accepted models.
- `code.skipPermissions` — `true` selects each CLI's dangerous permission-bypass flag. Default: `false`.
- `code.unset` — environment variables stripped from the coder's environment.

Unknown keys are rejected. An unreadable file, invalid JSON or an invalid value fails every command that loads the config, with an error naming the file.

Companion directories are declared in `~/.config/alignfirst/companions.json`, which the `alignfirst` CLI reads for both tools. See [its README](https://github.com/paleo/alignfirst/tree/main/packages/alignfirst#companion-directories).

## Execution model

`aldev code` runs the coder as a direct **foreground** child of its own process. It streams a live transcript to stdout and to a per-run session file, whose frontmatter status goes from `running` to `succeeded` or `failed`, and blocks until the coder exits. It never backgrounds or detaches itself.

Coding runs can be very long, so the caller always runs `aldev code` as a background task and owns the backgrounding. Under OpenClaw, the assistant invokes it through the `exec` tool with `background: true` and `timeoutSeconds: 0`, and chains `openclaw system event --mode now --session-key <key>` onto the command, as `aldev guide code` prescribes. The completion turn locates the session file with `aldev code status` and reads the result. The session file is the durable result handoff: frontmatter `sessionId` and status, and the `---- Result ----` block.

If `aldev code` is terminated, its signal handlers seal the session file (`status: failed`, `exitReason: terminated`), then send `SIGTERM` to the coder. After a short grace period, a `SIGKILL` guarantees no orphan is left behind. Only a `SIGKILL` of `aldev` itself can leave a stale `running` status, which the next `status` call seals.

When the coding agent's session on the host is missing or expired, `aldev code` detects the authentication failure in its stream, seals the session file with `exitReason: auth_required`, and exits `2` with a one-line stderr message.

## Coding agents

Install the selected CLI and authenticate it on the host: run `claude`, then `/login`, for Claude Code; run `codex login` for Codex.

Normal runs use Claude's `--permission-mode auto` or Codex's `--sandbox workspace-write`.

Claude's default model list is `fable`, `opus`, `sonnet`, `haiku`. Codex's is `astra`, `sol`, `terra`, `luna`; `aldev code` resolves a selected Codex alias against `codex debug models --bundled`. Set `code.models` to narrow the list or to advertise an explicit Codex slug such as `gpt-5.6-terra`.

Session files record `agent`. A session resumes only with the same selected agent. Agentless legacy sessions stay readable but require a new session.

## Port claims

Run `aldev project free-ports --size <n>` with the block size required by the project's workspace scheme: `perWorkspace × maxWorkspaces`. A marker entry without a code is the default range. Pass `--range <code>` to select a coded range. The setup guide writes the returned block as `portRange` in the project's `.alignfirst.json`.
