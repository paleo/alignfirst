# Autonomous agent

## AlignFirst Coaching

```bash
npx skills add https://github.com/paleo/alignfirst --global --skill alignfirst-coaching
```

Optional environment variables:

```bash
export ALIGNFIRST_AGENT_LOG_DIR=path/to/directory # Write input/output logs
export ALIGNFIRST_AGENT_SKIP_PERMISSIONS=1        # Use --dangerously-skip-permissions instead of --permission-mode auto
```

## Coaching by OpenClaw (experimental)

The `alignfirst-coaching` skill ships a reference that teaches OpenClaw how to drive AlignFirst from chat (Slack, Discord): interpreting user messages as project work, delegating to the coding agent, managing worktrees, branches, commits, and PRs. Still in development.

See [skills/alignfirst-coaching/references/coaching-by-openclaw.md](skills/alignfirst-coaching/references/coaching-by-openclaw.md).
