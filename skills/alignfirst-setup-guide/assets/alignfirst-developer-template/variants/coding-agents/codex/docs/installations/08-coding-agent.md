---
title: Codex Setup
read_when:
  - installing or authenticating the delegated Codex agent
---

# Codex Setup

**Role: service user.** Authentication is an interactive human action. It is independent from the
OpenClaw runtime provider and must not be represented by an environment placeholder or credential
file in this repository.

## Install and Authenticate

Install Codex with OpenAI's current [CLI installer](https://developers.openai.com/codex/cli), then
start it in the admin repository and choose an interactive sign-in method:

```sh
curl -fsSL https://chatgpt.com/codex/install.sh | sh
codex
```

Set `ALIGNFIRST_CODE_AGENT=codex` in `infra/openclaw/secrets/environment`; this selects delegation,
not the gateway model.

## Install Skills

From the admin repository root, install the named AlignFirst bundle globally, retain the setup guide
globally, and install `sysadmin` only in this project:

```sh
npx -y skills add https://github.com/paleo/alignfirst --global --yes \
  --agent codex \
  --skill alignfirst --skill alspec --skill alplan --skill al --skill almerge \
  --skill alreview --skill aldescription --skill alread </dev/null
npx -y skills add https://github.com/paleo/alignfirst --global --yes \
  --agent codex --skill alignfirst-setup-guide </dev/null
npx -y skills add https://github.com/paleo/skills --yes \
  --agent codex --skill sysadmin </dev/null
```

The seed merges the reviewed global source into `${CODEX_HOME:-~/.codex}/AGENTS.md` inside a managed
block. It preserves unrelated global instructions, agent configuration, skills, and user settings.
Codex reads the repository's canonical root `AGENTS.md` directly.

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
ALIGNFIRST_CODE_AGENT=codex alcode --guide
alproject --guide
npx -y skills list --global --agent codex --json
npx -y skills list --agent codex --json
```

The delegation guide must report Codex, and the project guide must load successfully. Start a new
`codex` session and verify `$alspec`, `$alplan`, `$al`, `$almerge`, `$alreview`, `$aldescription`,
and `$alread`. Delegate a read-only protocol task through OpenClaw and confirm its `_alcode` session
record reports `agent: codex`.
