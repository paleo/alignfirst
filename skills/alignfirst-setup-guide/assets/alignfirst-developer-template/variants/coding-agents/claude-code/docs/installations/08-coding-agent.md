---
title: Claude Code Setup
read_when:
  - installing, authenticating, locking or updating Claude Code in either account
  - a delegated run ends with exit reason auth_required
---

# Claude Code Setup

Position: after `04-openclaw.md`, before `06-security-hardening.md`. Two sections run earlier: [Admin Account](#admin-account) during `01-server-setup.md`, [Install](#install) during `03-toolchain.md`. Every Claude Code command of this deployment lives here; the base runbooks link to these sections.

Claude Code is installed in both accounts. The operator drives the admin account with it and the project-local `sysadmin` skill; the service account runs it through `alcode`, one fresh `claude` process per delegated run.

## Admin Account

**Role: human**, in the `{{SERVER_ADMIN_USER}}` shell, as the last step of `01-server-setup.md`.

Durable context lives in the repository (`AGENTS.md`, `docs/`), so auto-memory and auto-dream are disabled. The server has no use for claude.ai connectors either.

```sh
curl -fsSL https://claude.ai/install.sh | bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
echo "alias claudy='claude --dangerously-skip-permissions'" >> ~/.bashrc
source ~/.bashrc

[ -f ~/.claude/settings.json ] || echo '{}' > ~/.claude/settings.json
tmp=$(mktemp) && jq '. + {disableClaudeAiConnectors: true, autoMemoryEnabled: false, autoDreamEnabled: false}' \
  ~/.claude/settings.json > "$tmp" && mv "$tmp" ~/.claude/settings.json
```

> **User action required.** Start `claude` in the home directory and complete `/login` with the account that operates this server. Continue with `02-admin-repository.md` from that session: it clones the admin repository, and the operator runs every later runbook from there.

## Service Account

### Install

**Role: operator**, during `03-toolchain.md`, once `~/.npmrc` points at the shared prefix. The seed in `04-openclaw.md` refuses to run without the binary.

```sh
sudo -i -u {{SERVICE_USER}} -- /usr/bin/npm install -g @anthropic-ai/claude-code
sudo -i -u {{SERVICE_USER}} -- bash -lc 'which claude && claude --version'
# Expected: /home/{{SERVICE_USER}}/.npm-system-global/bin/claude
```

Same user settings as the admin account, and the same alias for interactive `sudo -i -u {{SERVICE_USER}}` shells:

```sh
sudo -H -u {{SERVICE_USER}} bash -lc '[ -f ~/.claude/settings.json ] || echo "{}" > ~/.claude/settings.json
jq ". + {disableClaudeAiConnectors: true, autoMemoryEnabled: false, autoDreamEnabled: false}" \
  ~/.claude/settings.json > ~/.claude/settings.json.new && mv ~/.claude/settings.json.new ~/.claude/settings.json'
sudo -H -u {{SERVICE_USER}} bash -c "echo \"alias claudy='claude --dangerously-skip-permissions'\" >> ~/.bashrc"
```

### Authenticate

**Role: human**, after `04-openclaw.md`. Claude Code keeps its own login (subscription or console account), independent from the OpenClaw model provider. The seed strips `ANTHROPIC_API_KEY` from every delegated run (`environment.d/coding-agent.conf`), so this login is the only credential the coding agent uses.

> **User action required.** The login prints a URL and waits for a one-shot code on stdin, tied to the same process. Run it from an interactive service-account shell, in a fresh terminal as `{{SERVER_ADMIN_USER}}`.

```sh
sudo -i -u {{SERVICE_USER}}
claude                    # /login, then follow the browser flow and paste the code; /exit
cd {{PROJECTS_ROOT}} && claude   # accept "Trust this folder?", then /exit
claude auth status
exit
```

Trusting `{{PROJECTS_ROOT}}` once covers every project cloned under it; `alcode` starts `claude` inside the project directory, and an unanswered trust prompt would block the run.

### Skills

**Role: operator**, as the service account, after [Authenticate](#authenticate). Three tiers: `--agent universal` writes the canonical `~/.agents/skills/<name>`, which OpenClaw scans; `--agent claude-code` adds the `~/.claude/skills/<name>` symlink that the `claude` CLI reads; the seven command skills go to the `claude-code` tier only and stay outside OpenClaw's allowlist (`agents.defaults.skills` in `seed/common.sh`). `< /dev/null` on every `skills add`: its interactive UI reads stdin and would swallow the rest of the heredoc.

```sh
sudo -i -u {{SERVICE_USER}} bash <<'EOS'
set -e
npx -y skills add https://github.com/paleo/alignfirst --global --yes \
  --agent universal --agent claude-code \
  --skill alignfirst --skill alignfirst-setup-guide \
  --skill alignfirst-developer-openclaw-playbook < /dev/null
npx -y skills add https://github.com/paleo/skills --global --yes \
  --agent universal --agent claude-code --skill sharp-writing < /dev/null
npx -y skills add https://github.com/paleo/alignfirst --global --yes \
  --agent claude-code \
  --skill al --skill alplan --skill alspec --skill aldescription \
  --skill alreview --skill alcatchup --skill almerge < /dev/null
EOS
```

The `sysadmin` skill is project-local to the admin repository and belongs to the operator's account, never to the service account. The render step installed it, so a fresh clone already carries it; from the repository root in `{{SERVER_ADMIN_USER}}`'s shell, this command is a no-op check:

```sh
npx -y skills add https://github.com/paleo/skills --yes --agent claude-code --skill sysadmin < /dev/null
```

### Global Instructions

The seed merges `infra/openclaw/coding-agent/CLAUDE.md` into `~/.claude/CLAUDE.md`, between `<!-- alignfirst-developer:start -->` and `<!-- alignfirst-developer:end -->`. Content outside the markers is preserved. Every `claude` process of the service account reads the file at startup, the delegated runs included, so a change needs no gateway restart.

To change the instructions, edit the repository file and run `docs/operations/configure-developer.md` with its `config instructions` scopes. The maintenance wrapper contains the developer before either file becomes writable and restores both through an `EXIT` trap.

### Hardening

**Role: operator**, during `06-security-hardening.md`. `~/.claude/skills` (the symlinks) and `~/.claude/CLAUDE.md` feed the delegated coder's prompt, so both become admin-owned and immutable. `~/.claude` itself stays writable: the CLI keeps its login and session state there. The flag goes on the instruction file, since a writable parent would let the account unlink it and write its own.

```sh
sudo chattr -i /home/{{SERVICE_USER}}/.claude/skills /home/{{SERVICE_USER}}/.claude/CLAUDE.md 2>/dev/null || true
sudo chown -Rh {{SERVER_ADMIN_USER}}:{{SERVER_ADMIN_USER}} /home/{{SERVICE_USER}}/.claude/skills /home/{{SERVICE_USER}}/.claude/CLAUDE.md
sudo find /home/{{SERVICE_USER}}/.claude/skills -type d -exec chmod 755 {} +
sudo find /home/{{SERVICE_USER}}/.claude/skills -type f -exec chmod 644 {} +
sudo chmod 644 /home/{{SERVICE_USER}}/.claude/CLAUDE.md
sudo chattr +i /home/{{SERVICE_USER}}/.claude/skills /home/{{SERVICE_USER}}/.claude/CLAUDE.md
```

Verify: the first two commands fail (`Permission denied`, `Operation not permitted`), the third works.

```sh
sudo -i -u {{SERVICE_USER}} -- bash -c 'echo x >> ~/.claude/CLAUDE.md'
sudo -i -u {{SERVICE_USER}} -- bash -c 'rm ~/.claude/CLAUDE.md'
sudo -i -u {{SERVICE_USER}} -- claude auth status
```

### Update

**Role: operator**, during `docs/operations/update-developer.md`.

Run the coding-agent package update through its own package-scoped maintenance window:

```sh
sudo /usr/local/sbin/alignfirst-developer-maintenance packages -- \
  /usr/bin/npm install -g @anthropic-ai/claude-code@latest
```

The `skills` scope of `update-developer.md` includes `~/.claude/skills`, so the symlink tier is restored with the canonical tree.

### Verification

After the seed and the gateway start (`04-openclaw.md`):

```sh
sudo -i -u {{SERVICE_USER}} -- bash -lc 'alcode --guide | head'      # names claude as the agent
sudo -i -u {{SERVICE_USER}} -- bash -lc 'alproject --guide >/dev/null && echo alproject-ok'
sudo -i -u {{SERVICE_USER}} -- bash -lc 'npx -y skills list -g --json'   # 11 skills: 4 shared, 7 commands
```

In an interactive session as the service account (`sudo -i -u {{SERVICE_USER}}`, then `claude` in a project), `/al`, `/alplan`, `/alspec`, `/aldescription`, `/alreview`, `/alcatchup` and `/almerge` are offered. The surface smoke test in `07-channel.md` delegates a read-only run from the channel; its session file under `.plans/**/_alcode/*.md` records `agent: claude`.
