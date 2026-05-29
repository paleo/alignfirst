# OpenClaw Coder (experimental)

A neutral, shareable setup that packages OpenClaw as an autonomous AI programmer: a reference workspace and a regression-test harness.

## Layout

- [`workspace/`](workspace/) — the `myclaw` reference OpenClaw workspace (personality files: `AGENTS.md`, `IDENTITY.md`, `SOUL.md`, `USER.md`, `TOOLS.md`). `AGENTS.md` points at the `alignfirst-agent` skill for its operating instructions; the playbook itself lives in the skill, not here.
- [`playbook-test/`](playbook-test/) — a Dockerised regression-test harness that drives this workspace through synthetic Discord and Slack channels.

## AlignFirst Agent skill

The operating-instructions playbook lives in the `alignfirst-agent` skill. Install it:

```bash
npx skills add https://github.com/paleo/alignfirst --global --skill alignfirst-agent
```

Optional environment variables:

```bash
export ALIGNFIRST_AGENT_LOG_DIR=path/to/directory # Write input/output logs
export ALIGNFIRST_AGENT_SKIP_PERMISSIONS=1        # Use --dangerously-skip-permissions instead of --permission-mode auto
```

### OpenClaw Playbook (experimental)

The `alignfirst-agent` skill ships a reference playbook that teaches OpenClaw how to handle branches, worktrees, commits, PRs/MRs etc. on the project side, and organize the chat with the user through Discord/Slack threads on the user side. Still in development.

See [../skills/alignfirst-agent/openclaw-playbook/](../skills/alignfirst-agent/openclaw-playbook/).

## Test harness

[`playbook-test/`](playbook-test/) builds on the four `@paleo/openclaw-*` packages. It bind-mounts the `alignfirst-agent` skill into the gateway, so playbook edits iterate without rebuilding the image. See [playbook-test/README.md](playbook-test/README.md) and the upstream [packages/openclaw-test/README.md](../packages/openclaw-test/README.md).

## Real deployment

The harness drives the workspace through synthetic `discord-mock` / `slack-mock` channels — no real bot needed. To run `myclaw` against real Discord and Slack workspaces, set up the provider-side bot applications first: see [bot-setup.md](bot-setup.md).

For how OpenClaw assembles the agent's context (what's auto-loaded, the surface/session model, thread routing, debug env vars), see [../docs/openclaw-context-engineering.md](../docs/openclaw-context-engineering.md).
