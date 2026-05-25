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

## OpenClaw QA toolkit

`@paleo/openclaw-test` and three companion channel packages — a Dockerised regression-test harness that drives OpenClaw through synthetic Discord and Slack channels. See [packages/openclaw-test/README.md](packages/openclaw-test/README.md).

### OpenClaw Playbook (experimental)

The `alignfirst-coaching` skill ships a reference that teaches OpenClaw how to handle branches, worktrees, commits, PRs/MRs etc. on the project side, and organize the chat with the user through Discord/Slack threads on the user side. Still in development.

See [skills/alignfirst-coaching/references/openclaw-playbook.md](skills/alignfirst-coaching/references/openclaw-playbook.md).
