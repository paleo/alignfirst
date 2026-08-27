---
title: Claude Code Setup
read_when:
  - installing or authenticating the delegated Claude Code agent
---

# Claude Code Setup

**Role: service user.** Authentication is an interactive human action. It is independent from the
OpenClaw runtime provider and must not be represented by an environment placeholder or credential
file in this repository.

## Install and Authenticate

Install Claude Code using Anthropic's current [setup
instructions](https://docs.anthropic.com/en/docs/claude-code/getting-started), then start it as the
service user and complete interactive login:

```sh
npm install --global @anthropic-ai/claude-code
claude
```

Use `/login` if the initial session does not prompt. Exit and check the installation with
`claude doctor`. Set `ALIGNFIRST_CODE_AGENT=claude` in
`infra/openclaw/secrets/environment`; this selects delegation, not the gateway model.

## Install Skills

From the admin repository root, install the named AlignFirst bundle globally, retain the setup guide
globally, and install `sysadmin` only in this project:

```sh
npx -y skills add https://github.com/paleo/alignfirst --global --yes \
  --agent claude-code \
  --skill alignfirst --skill alspec --skill alplan --skill al --skill almerge \
  --skill alreview --skill aldescription --skill alread </dev/null
npx -y skills add https://github.com/paleo/alignfirst --global --yes \
  --agent claude-code --skill alignfirst-setup-guide </dev/null
npx -y skills add https://github.com/paleo/skills --yes \
  --agent claude-code --skill sysadmin </dev/null
```

`CLAUDE.md` at the repository root imports canonical `AGENTS.md`. The seed merges the reviewed
global source into `~/.claude/CLAUDE.md` inside a managed block and preserves unrelated
instructions.

## Verify

```sh
infra/openclaw/seed.sh
infra/openclaw/bin/apply-workspace.sh
openclaw config validate
openclaw secrets audit
install -m 0600 infra/openclaw/secrets/environment \
  "$HOME/.config/alignfirst-developer/environment"
systemctl --user enable --now openclaw-gateway.service
systemctl --user status openclaw-gateway.service
openclaw channels status --probe
ALIGNFIRST_CODE_AGENT=claude alcode --guide
alproject --guide
npx -y skills list --global --agent claude-code --json
npx -y skills list --agent claude-code --json
```

The delegation guide must report Claude Code, and the project guide must load successfully. Start a
new `claude` session and verify `/alspec`, `/alplan`, `/al`, `/almerge`, `/alreview`,
`/aldescription`, and `/alread`. Delegate a read-only protocol task through OpenClaw and confirm
its `_alcode` session record reports `agent: claude`.
