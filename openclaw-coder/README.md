# OpenClaw Coder (experimental)

A neutral, shareable setup that packages OpenClaw as an autonomous AI programmer: a reference workspace and a regression-test harness.

## Layout

- [`workspace/`](workspace/) — the `myclaw` reference OpenClaw workspace (personality files: `AGENTS.md`, `IDENTITY.md`, `SOUL.md`, `USER.md`, `TOOLS.md`). `AGENTS.md` loads the `openclaw-coder-playbook` skill first on every message; the playbook lives in that skill, not here.
- [`playbook-test/`](playbook-test/) — a Dockerised regression-test harness that drives this workspace through synthetic Discord and Slack channels.

## Skills

Two skills, with distinct roles — install both:

```bash
npx skills add https://github.com/paleo/alignfirst --global \
  --skill openclaw-coder-playbook --skill alignfirst-coaching
```

- **`openclaw-coder-playbook`** — the operating-instructions dispatcher. Its `SKILL.md` routes each user message by surface (thread → working session, channel/DM → channel handling); the procedures live in its [`references/`](../skills/openclaw-coder-playbook/references/). The workspace `AGENTS.md` loads this skill first, so the agent's first read each turn is procedural — not coaching vocabulary (this read-order matters; see [../docs/writing-workspace-files.md](../docs/writing-workspace-files.md)).
- **`alignfirst-coaching`** — the coaching/CLI skill the playbook delegates *coding* to (spec / plan / AAD protocols via a CLI wrapper). Read only at delegation time, after the workspace is set up.

Optional `alignfirst-coaching` environment variables:

```bash
export ALIGNFIRST_COACHING_LOG_DIR=path/to/directory # Write input/output logs
export ALIGNFIRST_COACHING_SKIP_PERMISSIONS=1        # Use --dangerously-skip-permissions instead of --permission-mode auto
```

## Test harness

[`playbook-test/`](playbook-test/) builds on the four `@paleo/openclaw-*` packages. It bind-mounts both the `openclaw-coder-playbook` and `alignfirst-coaching` skills into the gateway, so playbook edits iterate without rebuilding the image. See [playbook-test/README.md](playbook-test/README.md) and the upstream [packages/openclaw-test/README.md](../packages/openclaw-test/README.md).

## Real deployment

The harness drives the workspace through synthetic `discord-mock` / `slack-mock` channels — no real bot needed. To run `myclaw` against real Discord and Slack workspaces, set up the provider-side bot applications first: see [bot-setup.md](bot-setup.md).

For how OpenClaw assembles the agent's context (what's auto-loaded, the surface/session model, thread routing, debug env vars), see [../docs/openclaw-context-engineering.md](../docs/openclaw-context-engineering.md).
