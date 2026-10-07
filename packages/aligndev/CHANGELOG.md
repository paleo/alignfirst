# aligndev

## 0.20.0

### Minor Changes

- 393b05a: Moved the config to `~/.alignfirst/aligndev.config.json`. A relative `projectsRoot` now resolves against `~/.alignfirst/`.
- 393b05a: Made `~/.alignfirst/aligndev.config.json` optional: `platform` defaults to `codingAgent`, and `code.agent` defaults to the coding agent that runs `aligndev`, Claude Code or Codex.

### Patch Changes

- 393b05a: The playbook now calls the coding agent it launches "the agent".
- 393b05a: Supported Node 22.11 and later.

## 0.19.0

### Minor Changes

- 7af8fd1: Added the `codingAgent` platform: a Claude Code or Codex session acts as the assistant on one project, started by the new `aligndev` skill. `aligndev` now runs through `npx`, and then prints and runs `npx -y aligndev` and `npx -y alignfirst`. The config now requires `platform` and `code`.
- 7af8fd1: Added companion directory support. `aligndev code` writes its session files where `alignfirst config` locates them, makes the companion writable for the coder, and gives a new session the project context. `aligndev project` lists every Git main worktree as a project, except a work-files clone, and reports its companion directory.
- 7af8fd1: Released `aligndev`, which replaces `@alignfirst/alcode` and `@alignfirst/alproject` and ships the assistant playbook: `aligndev code`, `aligndev project` and `aligndev guide`, configured through `~/.config/alignfirst/aligndev.config.json`. Session files move from `_alcode/` to `_aligndev/`: rename the existing directories to resume earlier sessions.
