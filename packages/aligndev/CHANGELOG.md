# aligndev

## 0.22.0

### Minor Changes

- de96381: `aligndev project status` resolves a relative path against the working directory, so `status .` works from a project. Renamed the `.alignfirst.md` companion item to `.alignfirst-instructions`. The playbook unregisters a project's companion before removing the project, and deletes the companion directory when the user chooses to.

### Patch Changes

- de96381: Renamed the AlignFirst Dev Kit to AlignDev; its OpenClaw deployment is AlignDev for OpenClaw. The product page moved to <https://alignfirst.paroi.tech/aligndev>.

## 0.21.0

### Minor Changes

- 24f0212: The coding-agent assistant works in the session's directory and branch, asks before moving uncommitted work, and reads `README.md` when the project has no `DEVELOPERS.md`.

### Patch Changes

- 24f0212: Fixed the Discord channel handoff, which could post a line in the new thread ahead of the starter.

## 0.20.2

### Patch Changes

- e5ac2f5: The delegation guide describes the coder's numbered questions and how to answer or accept them.

## 0.20.1

### Patch Changes

- 2245262: The playbook now registers a project through `alignfirst companion add` before preparing it through its companion, instead of asking the operator for an entry.
- 2245262: On OpenClaw, the starter is the channel turn's reply: the turn ends on `NO_REPLY` instead of a pointer to the thread, which Discord posted inside the thread. On Discord, `thread-create` opens the thread without content and `thread-reply` posts the starter.

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
