---
title: Codex Setup
read_when:
  - installing, authenticating, locking or updating Codex in either account
  - a delegated run ends with exit reason auth_required or a 401
  - Codex logs `failed to install system skills`
---

# Codex Setup

Position: after `04-openclaw.md`, before `06-security-hardening.md`. Two sections run earlier: [Admin Account](#admin-account) during `01-server-setup.md`, [Install](#install) during `03-toolchain.md`. Every Codex command of this deployment lives here; the base runbooks link to these sections.

Codex is installed in both accounts. The operator drives the admin account with it and the project-local `sysadmin` skill; the service account runs it through `alcode`, one fresh `codex` process per delegated run.

## Admin Account

**Role: human**, in the `{{SERVER_ADMIN_USER}}` shell, as the last step of `01-server-setup.md`.

The vendor installer places the binary under `~/.local/bin`; `npm install -g @openai/codex` under the admin account's Node is the alternative. `--yolo` is absent from `codex --help` yet accepted: it is the hidden alias of `--dangerously-bypass-approvals-and-sandbox`. Codex has no memory feature to disable; durable context lives in the repository (`AGENTS.md`, `docs/`).

```sh
curl -fsSL https://chatgpt.com/codex/install.sh | sh
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
echo "alias codexy='codex --yolo'" >> ~/.bashrc
source ~/.bashrc
```

> **User action required.** Run `codex login` (or `codex login --device-auth` when the account allows device codes, see [Authenticate](#authenticate)) with the account that operates this server. Then start `codex` in the home directory and continue with `02-admin-repository.md` from that session: it clones the admin repository, and the operator runs every later runbook from there.

## Service Account

### Install

**Role: operator**, during `03-toolchain.md`, once `~/.npmrc` points at the shared prefix. The seed in `04-openclaw.md` refuses to run without the binary.

```sh
sudo -i -u {{SERVICE_USER}} -- /usr/bin/npm install -g @openai/codex
sudo -i -u {{SERVICE_USER}} -- bash -lc 'which codex && codex --version'
# Expected: /home/{{SERVICE_USER}}/.npm-system-global/bin/codex
```

The same alias for interactive `sudo -i -u {{SERVICE_USER}}` shells:

```sh
printf "alias codexy='codex --yolo'\n" | sudo -H -u {{SERVICE_USER}} tee -a /home/{{SERVICE_USER}}/.bashrc
```

### Authenticate

**Role: human**, after `04-openclaw.md`. Codex keeps its own login under `~/.codex/auth.json`, independent from the OpenClaw runtime provider. When that provider is itself the Codex plugin, the two keep separate Codex homes: leave `plugins.entries.codex.config.appServer.homeScope` at its default, and authenticate both. The seed strips `OPENAI_API_KEY`, `CODEX_API_KEY` and OpenClaw's `CODEX_*` exports from every delegated run (`environment.d/coding-agent.conf`), so this login is the only credential the coding agent uses.

> **User action required.** Enable the flow on the account first: ChatGPT settings, **Security**, **Enable device code authorization for Codex**. Then run the login from an interactive service-account shell, in a fresh terminal as `{{SERVER_ADMIN_USER}}`, and complete it in a laptop browser signed in to that account.

```sh
sudo -i -u {{SERVICE_USER}}
codex login --device-auth
codex login status
exit
```

`~/.codex/auth.json` is a secret: never copy it into the repository, the seed or a project. When the account forbids device codes, run `codex login` without the flag through an SSH tunnel to the localhost callback port it prints.

### Skills

**Role: operator**, as the service account, after [Authenticate](#authenticate). Three tiers: `--agent universal` writes the canonical `~/.agents/skills/<name>`, which OpenClaw scans; `--agent codex` records the same canonical in the lock file for the `codex` CLI, which reads `~/.agents/skills/` too and needs no symlink; the seven command skills go to the `codex` tier only and stay outside OpenClaw's allowlist (`agents.defaults.skills` in `seed/common.sh`). `< /dev/null` on every `skills add`: its interactive UI reads stdin and would swallow the rest of the heredoc.

```sh
sudo -i -u {{SERVICE_USER}} bash <<'EOS'
set -e
npx -y skills add https://github.com/paleo/alignfirst --global --yes \
  --agent universal --agent codex \
  --skill alignfirst --skill alignfirst-setup-guide \
  --skill alignfirst-developer-openclaw-playbook < /dev/null
npx -y skills add https://github.com/paleo/skills --global --yes \
  --agent universal --agent codex --skill sharp-writing < /dev/null
npx -y skills add https://github.com/paleo/alignfirst --global --yes \
  --agent codex \
  --skill al --skill alplan --skill alspec --skill aldescription \
  --skill alreview --skill alread --skill almerge < /dev/null
EOS
```

The `sysadmin` skill is project-local to the admin repository and belongs to the operator's account, never to the service account. The render step installed it, so a fresh clone already carries it; from the repository root in `{{SERVER_ADMIN_USER}}`'s shell, this command is a no-op check:

```sh
npx -y skills add https://github.com/paleo/skills --yes --agent codex --skill sysadmin < /dev/null
```

**System skills.** Codex unpacks its bundled skills into `~/.codex/skills/.system/` at session start, behind a content-hash marker. Run this block before `06-security-hardening.md`. `codex exec` reads stdin even with a prompt argument, hence `< /dev/null`.

```sh
sudo -H -u {{SERVICE_USER}} mkdir -p /home/{{SERVICE_USER}}/.codex/skills
sudo chattr -i /home/{{SERVICE_USER}}/.codex/skills 2>/dev/null || true
sudo chown -Rh {{SERVICE_USER}}:{{SERVICE_USER}} /home/{{SERVICE_USER}}/.codex/skills
sudo -i -u {{SERVICE_USER}} -- bash -lc 'cd /tmp && codex exec --sandbox read-only --skip-git-repo-check -C /tmp "Reply with exactly OK and stop."' < /dev/null
sudo chown -Rh {{SERVER_ADMIN_USER}}:{{SERVER_ADMIN_USER}} /home/{{SERVICE_USER}}/.codex/skills
sudo find /home/{{SERVICE_USER}}/.codex/skills -type d -exec chmod 755 {} +
sudo find /home/{{SERVICE_USER}}/.codex/skills -type f -exec chmod 644 {} +
sudo chattr +i /home/{{SERVICE_USER}}/.codex/skills
```

After `06`, run the same refresh through the root-owned maintenance wrapper. It contains the developer before the directory becomes writable and restores the directory through an `EXIT` trap:

```sh
sudo /usr/local/sbin/alignfirst-developer-maintenance agent-skills -- bash -lc \
  'cd /tmp && codex exec --sandbox read-only --skip-git-repo-check -C /tmp "Reply with exactly OK and stop."' \
  < /dev/null
```

The bundled `skill-creator` and `skill-installer` become visible to the delegated coder. They cannot persist anything: both skill roots are admin-owned, so an install attempt fails with `Permission denied`.

### Global Instructions

The seed merges `infra/openclaw/coding-agent/AGENTS.md` into `${CODEX_HOME:-~/.codex}/AGENTS.md`, between `<!-- alignfirst-developer:start -->` and `<!-- alignfirst-developer:end -->`. Content outside the markers is preserved. Every `codex` process of the service account reads the file at startup, the delegated runs included, so a change needs no gateway restart.

To change the instructions, edit the repository file and run `docs/operations/configure-developer.md` with its `config instructions` scopes. The maintenance wrapper contains the developer before either file becomes writable and restores both through an `EXIT` trap.

### Hardening

**Role: operator**, during `06-security-hardening.md`, after the system-skills block of [Skills](#skills). `~/.codex/skills` and `~/.codex/AGENTS.md` feed the delegated coder's prompt, so both become admin-owned and immutable. `~/.codex` itself stays writable: the CLI keeps `auth.json` (a secret) and its session state there. The flag goes on the instruction file, since a writable parent would let the account unlink it and write its own.

```sh
sudo chattr -i /home/{{SERVICE_USER}}/.codex/skills /home/{{SERVICE_USER}}/.codex/AGENTS.md 2>/dev/null || true
sudo chown -Rh {{SERVER_ADMIN_USER}}:{{SERVER_ADMIN_USER}} /home/{{SERVICE_USER}}/.codex/skills /home/{{SERVICE_USER}}/.codex/AGENTS.md
sudo find /home/{{SERVICE_USER}}/.codex/skills -type d -exec chmod 755 {} +
sudo find /home/{{SERVICE_USER}}/.codex/skills -type f -exec chmod 644 {} +
sudo chmod 644 /home/{{SERVICE_USER}}/.codex/AGENTS.md
sudo chattr +i /home/{{SERVICE_USER}}/.codex/skills /home/{{SERVICE_USER}}/.codex/AGENTS.md
```

Verify: the first three commands fail (`Permission denied`, `Operation not permitted`), the fourth works.

```sh
sudo -i -u {{SERVICE_USER}} -- bash -c 'echo x >> ~/.codex/AGENTS.md'
sudo -i -u {{SERVICE_USER}} -- bash -c 'rm ~/.codex/AGENTS.md'
sudo -i -u {{SERVICE_USER}} -- bash -c 'touch ~/.codex/skills/x'
sudo -i -u {{SERVICE_USER}} -- codex login status
```

### Update

**Role: operator**, during `docs/operations/update-developer.md`.

Run the coding-agent package update through its own package-scoped maintenance window:

```sh
sudo /usr/local/sbin/alignfirst-developer-maintenance packages -- \
  /usr/bin/npm install -g @openai/codex@latest
```

A Codex upgrade changes the system-skills marker, so repeat the post-hardening maintenance command in [Skills](#skills). Then verify the marker took: a second session prints nothing.

```sh
sudo -i -u {{SERVICE_USER}} -- bash -lc 'cd /tmp && codex exec --sandbox read-only --skip-git-repo-check -C /tmp "Reply with exactly OK and stop." 2>&1 | grep -i "system skills"' < /dev/null
```

The `skills` scope of `update-developer.md` covers `~/.agents` only. `skills update` writes nothing under `~/.codex/skills`, which holds Codex's own skills alone.

### Verification

After the seed and the gateway start (`04-openclaw.md`):

```sh
sudo -i -u {{SERVICE_USER}} -- bash -lc 'alcode --guide | head'      # names codex as the agent
sudo -i -u {{SERVICE_USER}} -- bash -lc 'alproject --guide >/dev/null && echo alproject-ok'
sudo -i -u {{SERVICE_USER}} -- bash -lc 'npx -y skills list -g --json'   # 11 skills: 4 shared, 7 commands
```

In an interactive session as the service account (`sudo -i -u {{SERVICE_USER}}`, then `codex` in a project), `$al`, `$alplan`, `$alspec`, `$aldescription`, `$alreview`, `$alread` and `$almerge` are offered. The surface smoke test in `07-channel.md` delegates a read-only run from the channel; its session file under `.plans/**/_alcode/*.md` records `agent: codex`.
