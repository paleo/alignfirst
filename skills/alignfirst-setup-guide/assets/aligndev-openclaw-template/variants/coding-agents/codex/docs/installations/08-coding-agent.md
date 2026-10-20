---
title: Codex Setup
read_when:
  - installing, authenticating, locking or updating Codex in either account
  - a delegated run ends with exit reason auth_required or a 401
  - Codex logs `failed to install system skills`
---

# Codex Setup

Position: after `04-openclaw.md`, before `06-security-hardening.md`. Two sections run earlier: [Admin Account](#admin-account) during `01-server-setup.md`, [Install](#install) during `03-toolchain.md`. Every Codex command of this deployment lives here; the base runbooks link to these sections.

Codex is installed in both accounts. The operator drives the admin account with it and the project-local `sysadmin` skill; the service account runs it through `aligndev code`, one fresh `codex` process per delegated run.

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

**Role: operator**, during `03-toolchain.md`, once `admin-npm` is installed. The seed in `04-openclaw.md` refuses to run without the binary.

```sh
sudo -i -u {{SERVICE_USER}} -- /opt/{{SERVICE_USER}}/libexec/admin-npm install -g @openai/codex
sudo -i -u {{SERVICE_USER}} -- bash -lc 'which codex && codex --version'
# Expected: /home/{{SERVICE_USER}}/.npm-system-global/bin/codex
```

The same alias for interactive `sudo -i -u {{SERVICE_USER}}` shells:

```sh
printf "alias codexy='codex --yolo'\n" | sudo -H -u {{SERVICE_USER}} tee -a /home/{{SERVICE_USER}}/.bashrc
```

### Authenticate

**Role: human**, after `04-openclaw.md`. Codex keeps its own login under the selected profile's `<configDir>/auth.json`, independent from the OpenClaw model provider and its authentication. `aligndev code` strips `OPENAI_API_KEY`, `CODEX_API_KEY` and OpenClaw's `CODEX_*` exports from every delegated run (`code.profiles.service-codex.unset` in `infra/openclaw/aligndev.settings.json`), so this login is the only credential the coding agent uses.

> **User action required.** Enable the flow on the account first: ChatGPT settings, **Security**, **Enable device code authorization for Codex**. Then run the login from an interactive service-account shell, in a fresh terminal as `{{SERVER_ADMIN_USER}}`, and complete it in a laptop browser signed in to that account.

```sh
sudo -i -u {{SERVICE_USER}}
set -o pipefail
CODEX_HOME=$(/usr/bin/node /opt/{{SERVICE_USER}}/libexec/deployment-profiles.mjs \
  "$HOME/.alignfirst/aligndev.settings.json" "$HOME" \
  "$HOME/.alignfirst/aligndev.settings.json" | jq -r '.configDir') || exit 1
export CODEX_HOME
codex login --device-auth
codex login status
exit
```

`<configDir>/auth.json` is a secret: never copy it into the repository, the seed or a project. When the account forbids device codes, run `codex login` without the flag through an SSH tunnel to the localhost callback port it prints.

### Skills

**Role: operator**, as the service account, after [Authenticate](#authenticate). The setup guide and `sharp-writing` use two tiers: `--agent universal` writes the canonical `~/.agents/skills/<name>`, which OpenClaw scans; `--agent codex` records the same canonical in the lock file for the `codex` CLI, which reads `~/.agents/skills/` too and needs no symlink. The delegated agent needs no protocol skill: `aligndev code` names the `alignfirst guide` command in its prompt, and a prepared project runs `alignfirst context` from its instruction file. `< /dev/null` on every `skills add`: its interactive UI reads stdin and would swallow the rest of the heredoc.

```sh
sudo -i -u {{SERVICE_USER}} bash <<'EOS'
set -e
npx -y skills add https://github.com/paleo/alignfirst --global --yes \
  --agent universal --agent codex \
  --skill alignfirst-setup-guide < /dev/null
npx -y skills add https://github.com/paleo/skills --global --yes \
  --agent universal --agent codex --skill sharp-writing < /dev/null
EOS
```

The `sysadmin` skill is project-local to the admin repository and belongs to the operator's account, never to the service account. The render step installed it, so a fresh clone already carries it; from the repository root in `{{SERVER_ADMIN_USER}}`'s shell, this command is a no-op check:

```sh
npx -y skills add https://github.com/paleo/skills --yes --agent codex --skill sysadmin < /dev/null
```

**System skills.** Codex unpacks bundled skills into `<configDir>/skills/.system/` at session start, behind a content-hash marker. Run this block before `06-security-hardening.md` for every inventoried Codex store, including quota-only stores. This is a live model-backed acceptance command, not an offline test. `codex exec` reads stdin even with a prompt argument, hence `< /dev/null`.

```sh
sudo -H -u {{SERVICE_USER}} bash -l <<'EOS'
set -eo pipefail
/usr/bin/node /opt/{{SERVICE_USER}}/libexec/deployment-profiles.mjs \
  "$HOME/.alignfirst/aligndev.settings.json" "$HOME" \
  "$HOME/.alignfirst/aligndev.settings.json" |
  jq -r '.stores[] | select(.agent == "codex") | .configDir' |
  while IFS= read -r store; do
    mkdir -p "$store/skills"
    CODEX_HOME="$store" codex exec --sandbox read-only --skip-git-repo-check \
      -C /tmp 'Reply with exactly OK and stop.' < /dev/null
  done
EOS
```

After `06`, run the same refresh through the root-owned maintenance wrapper. It contains the assistant before the directory becomes writable and restores the directory through an `EXIT` trap:

```sh
sudo /usr/local/sbin/alignfirst-assistant-maintenance agent-skills -- \
  env CODEX_HOME=<resolved-service-codex-dir> codex exec --sandbox read-only \
  --skip-git-repo-check -C /tmp 'Reply with exactly OK and stop.' < /dev/null
```

The bundled `skill-creator` and `skill-installer` become visible to the delegated agent. They cannot persist anything: both skill roots are admin-owned, so an install attempt fails with `Permission denied`.

### Global Instructions

The `service-codex` profile sets explicit `configDir: "~/.codex"`, overriding inherited `CODEX_HOME`. Isolated custom stores beneath the service home are supported. Set `CODEX_HOME` to each profile's inventoried resolved directory for authentication and native commands; the login example above selects the deployment default. Profiles sharing a store share its account. Optional quota credentials belong to the quota store independently of the coding child.

The seed merges `infra/openclaw/coding-agent/AGENTS.md` into `<configDir>/AGENTS.md` for every inventoried Codex store, between `<!-- alignfirst-dev-kit:start -->` and `<!-- alignfirst-dev-kit:end -->`. Content outside the markers is preserved. Every `codex` process of the service account reads the file at startup, the delegated runs included, so a change needs no gateway restart.

To change the instructions, edit the repository file and run `docs/operations/configure-assistant.md` with its `config instructions` scopes. The maintenance wrapper contains the assistant before either file becomes writable and restores both through an `EXIT` trap.

### Hardening

**Role: operator**, during `06-security-hardening.md`, after the system-skills block of [Skills](#skills). Use its shared `deployment-policy.mjs harden` command for every inventoried store. It protects instructions and skills, retains executable bits, and protects native roots and ancestors through root-owned sticky writable anchors. Authentication/session state stays writable. This Codex policy covers instructions/skills, not every native settings surface.

Verify each resolved store: opening instructions for writing, unlinking instructions and creating a native skill must fail; login status must work.

```sh
sudo -H -u {{SERVICE_USER}} bash -l <<'EOS'
set -eo pipefail
CODEX_HOME=$(/usr/bin/node /opt/{{SERVICE_USER}}/libexec/deployment-profiles.mjs \
  "$HOME/.alignfirst/aligndev.settings.json" "$HOME" \
  "$HOME/.alignfirst/aligndev.settings.json" | jq -r '.configDir')
export CODEX_HOME
if /usr/bin/node -e 'require("node:fs").openSync(process.argv[1], "r+")' "$CODEX_HOME/AGENTS.md"; then
  echo 'ERROR: instructions are writable' >&2; exit 1
fi
if rm "$CODEX_HOME/AGENTS.md"; then
  echo 'ERROR: instructions were removable; restore them before restart' >&2; exit 1
fi
if touch "$CODEX_HOME/skills/probe"; then
  echo 'ERROR: native skills are writable; remove probe and restore policy' >&2; exit 1
fi
codex login status
EOS
```

### Update

**Role: operator**, during `docs/operations/update-assistant.md`.

Run the coding-agent package update through its own package-scoped maintenance window:

```sh
sudo /usr/local/sbin/alignfirst-assistant-maintenance packages -- \
  /opt/{{SERVICE_USER}}/libexec/admin-npm install -g @openai/codex@latest
sudo -H -u {{SERVICE_USER}} bash -lc '
PROJECT_SHELL=/opt/{{SERVICE_USER}}/libexec/project-shell \
DEFAULT_NODE=<default-node-version> PINNED_NODE=<project-node-version> \
CODING_AGENT=codex \
  /opt/{{SERVICE_USER}}/libexec/check-project-runtimes.sh
'
```

A Codex upgrade changes the system-skills marker, so repeat the post-hardening maintenance command in [Skills](#skills). Then verify the marker took: a second session prints nothing.

```sh
sudo -H -u {{SERVICE_USER}} env CODEX_HOME=<resolved-service-codex-dir> \
  bash -lc 'cd /tmp && codex exec --sandbox read-only --skip-git-repo-check -C /tmp "Reply with exactly OK and stop." 2>&1 | grep -i "system skills"' < /dev/null
```

The `skills` scope of `update-assistant.md` covers `~/.agents` and `~/.openclaw/skills`. Codex's bundled skills under `~/.codex/skills` use the separate `agent-skills` scope.

### Verification

These host-side acceptance procedures are separate from offline template tests. Repeat authentication/permission and bundled-skill refresh checks for every provisioned store. Verify the recorded profile as well as `agent: codex` in delegated session files.

After the seed and the gateway start (`04-openclaw.md`):

```sh
sudo -i -u {{SERVICE_USER}} -- bash -lc 'aligndev code --help | grep selected'   # names codex as the agent
sudo -i -u {{SERVICE_USER}} -- bash -lc 'aligndev guide project >/dev/null && echo projects-ok'
sudo -i -u {{SERVICE_USER}} -- bash -lc 'npx -y skills list -g --json'        # 2 skills
```

Exercise the runtime harness through the real gateway. This catches shell-snapshot state that a direct invocation cannot reproduce:

```sh
sudo -H -u {{SERVICE_USER}} bash <<'EOF'
runtime_prompt='Run this read-only command with exec: PROJECT_SHELL=/opt/{{SERVICE_USER}}/libexec/project-shell DEFAULT_NODE=<default-node-version> PINNED_NODE=<project-node-version> CODING_AGENT=codex /opt/{{SERVICE_USER}}/libexec/check-project-runtimes.sh. Reply exactly RUNTIME_OK when it passes. Otherwise reply RUNTIME_CHECK_FAILED and include the failure output.'
/opt/{{SERVICE_USER}}/bin/openclaw agent --agent main \
  --session-id "$(cat /proc/sys/kernel/random/uuid)" \
  --message "$runtime_prompt" --json
EOF
```

The private turn must return `RUNTIME_OK`.

The surface smoke test in `07-channel.md` delegates a read-only run from the channel; its session file under `.plans/**/_aligndev/*.md` records `agent: codex`.
