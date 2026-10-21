---
title: Claude Code Setup
read_when:
  - installing, authenticating, locking or updating Claude Code in either account
  - a delegated run ends with exit reason auth_required
---

# Claude Code Setup

Position: after `04-openclaw.md`, before `06-security-hardening.md`. Two sections run earlier: [Admin Account](#admin-account) during `01-server-setup.md`, [Install](#install) during `03-toolchain.md`. Every Claude Code command of this deployment lives here; the base runbooks link to these sections.

Claude Code is installed in both accounts. The operator drives the admin account with it and the project-local `sysadmin` skill; the service account runs it through `aligndev code`, one fresh `claude` process per delegated run.

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

**Role: operator**, during `03-toolchain.md`, once `admin-npm` is installed. The seed in `04-openclaw.md` refuses to run without the binary.

```sh
sudo -i -u {{SERVICE_USER}} -- /opt/{{SERVICE_USER}}/libexec/admin-npm install -g @anthropic-ai/claude-code
set -o pipefail
settings=infra/openclaw/aligndev.settings.json
store=$(/usr/bin/node infra/openclaw/deployment-profiles.mjs "$settings" \
  /home/{{SERVICE_USER}} /home/{{SERVICE_USER}}/.alignfirst/aligndev.settings.json | jq -er '.configDir')
native_default=$(jq -r '.code.profiles[.code.profile].configDir == null' "$settings")
sudo -H -u {{SERVICE_USER}} bash -lc '
  if [ "$1" = true ]; then unset CLAUDE_CONFIG_DIR; else export CLAUDE_CONFIG_DIR="$2"; fi
  command -v claude && claude --version
' bash "$native_default" "$store"
# Expected: /home/{{SERVICE_USER}}/.npm-system-global/bin/claude
```

Same user settings as the admin account, and the same alias for interactive `sudo -i -u {{SERVICE_USER}}` shells:

```sh
set -o pipefail
store=$(/usr/bin/node infra/openclaw/deployment-profiles.mjs \
  infra/openclaw/aligndev.settings.json /home/{{SERVICE_USER}} \
  /home/{{SERVICE_USER}}/.alignfirst/aligndev.settings.json | jq -r '.configDir')
sudo -H -u {{SERVICE_USER}} env STORE_PATH="$store" bash -l <<'EOS'
set -e
store=$STORE_PATH
mkdir -p "$store"
[ -f "$store/settings.json" ] || echo '{}' > "$store/settings.json"
jq '. + {disableClaudeAiConnectors: true, autoMemoryEnabled: false, autoDreamEnabled: false}' \
  "$store/settings.json" > "$store/settings.json.new"
mv "$store/settings.json.new" "$store/settings.json"
EOS
sudo -H -u {{SERVICE_USER}} bash -c "echo \"alias claudy='claude --dangerously-skip-permissions'\" >> ~/.bashrc"
```

### Authenticate

**Role: human**, after `04-openclaw.md`. Claude Code keeps its own login (subscription or console account), independent from the OpenClaw model provider. `aligndev code` strips `ANTHROPIC_API_KEY` from every delegated run (`code.profiles.service-claude.unset` in `infra/openclaw/aligndev.settings.json`), so this login is the only credential the coding agent uses.

> **User action required.** The login prints a URL and waits for a one-shot code on stdin, tied to the same process. Run it from an interactive service-account shell, in a fresh terminal as `{{SERVER_ADMIN_USER}}`.

```sh
sudo -i -u {{SERVICE_USER}}
set -o pipefail
settings="$HOME/.alignfirst/aligndev.settings.json"
store=$(/usr/bin/node /opt/{{SERVICE_USER}}/libexec/deployment-profiles.mjs \
  "$settings" "$HOME" "$settings" | jq -er '.configDir') || exit 1
if jq -e '.code.profiles[.code.profile].configDir == null' "$settings" >/dev/null; then
  unset CLAUDE_CONFIG_DIR
else
  export CLAUDE_CONFIG_DIR="$store"
fi
unset ANTHROPIC_API_KEY
claude                    # /login, then follow the browser flow and paste the code; /exit
cd ~/projects && claude   # accept "Trust this folder?", then /exit
claude auth status
exit
```

Trusting `~/projects` once covers every project cloned under it; `aligndev code` starts `claude` inside the project directory, and an unanswered trust prompt would block the run.

### Skills

**Role: operator**, as the service account, after [Authenticate](#authenticate). Install canonical shared skills with `--agent universal`, then copy them into every inventoried Claude store. Managed native symlinks are rejected by the deployment policy, so do not use the CLI's `--agent claude-code` alias tier for this service account. The delegated agent needs no protocol skill: `aligndev code` names the `alignfirst guide` command in its prompt, and a prepared project runs `alignfirst context` from its instruction file. `< /dev/null` on every `skills add`: its interactive UI reads stdin and would swallow the rest of the heredoc.

```sh
sudo -H -u {{SERVICE_USER}} bash -l <<'EOS'
set -eo pipefail
npx -y skills add https://github.com/paleo/alignfirst --global --yes \
  --agent universal --skill alignfirst-setup-guide < /dev/null
npx -y skills add https://github.com/paleo/skills --global --yes \
  --agent universal --skill sharp-writing < /dev/null
/usr/bin/node /opt/{{SERVICE_USER}}/libexec/deployment-profiles.mjs \
  "$HOME/.alignfirst/aligndev.settings.json" "$HOME" \
  "$HOME/.alignfirst/aligndev.settings.json" |
  jq -r '.stores[] | select(.agent == "claude") | .skillsDir' |
  while IFS= read -r target; do
    mkdir -p "$target"
    for skill in alignfirst-setup-guide sharp-writing; do
      test ! -L "$target/$skill"
      mkdir -p "$target/$skill"
      rsync -a --delete "$HOME/.agents/skills/$skill/" "$target/$skill/"
    done
  done
EOS
```

The `sysadmin` skill is project-local to the admin repository and belongs to the operator's account, never to the service account. The render step installed it, so a fresh clone already carries it; from the repository root in `{{SERVER_ADMIN_USER}}`'s shell, this command is a no-op check:

```sh
npx -y skills add https://github.com/paleo/skills --yes --agent claude-code --skill sysadmin < /dev/null
```

### Global Instructions

The `service-claude` profile pins native-default mode with `configDir: null`, removing inherited `CLAUDE_CONFIG_DIR`. An explicit string sets that variable to its resolved path, even when it names `~/.claude`. Custom stores must be isolated beneath the service home. The login example selects the deployment default after login-shell initialization. For another profile, select its original setting and resolved inventory path; reproduce its `env`/`unset`, cwd and credential routing too. Additional stores need the same settings/skills preparation and their own authentication. Shared filesystem paths do not imply equivalent invocation modes. On macOS, an explicit default-directory string can select different Keychain credentials from an unset variable.

The seed merges `infra/openclaw/coding-agent/CLAUDE.md` into `<configDir>/CLAUDE.md` for every inventoried Claude store, between `<!-- alignfirst-dev-kit:start -->` and `<!-- alignfirst-dev-kit:end -->`. Content outside the markers is preserved. Every `claude` process of the service account reads the file at startup, the delegated runs included, so a change needs no gateway restart.

To change the instructions, edit the repository file and run `docs/operations/configure-assistant.md` with its `config instructions` scopes. The maintenance wrapper contains the assistant before either file becomes writable and restores both through an `EXIT` trap.

### Hardening

**Role: operator**, during `06-security-hardening.md`. Use its shared `deployment-policy.mjs harden` command for every inventoried store. It protects instructions and real native skill copies, preserves executable modes, and protects root replacement through root-owned sticky writable anchors. Credentials and sessions remain writable. This Claude policy covers instructions/skills; it does not certify every native settings surface. Do not restore the former symlink-based skill policy.

Verify in each resolved store: opening instructions for writing and unlinking must fail; authentication status must work.

```sh
sudo -H -u {{SERVICE_USER}} bash -l <<'EOS'
set -eo pipefail
settings="$HOME/.alignfirst/aligndev.settings.json"
store=$(/usr/bin/node /opt/{{SERVICE_USER}}/libexec/deployment-profiles.mjs \
  "$settings" "$HOME" "$settings" | jq -er '.configDir')
if jq -e '.code.profiles[.code.profile].configDir == null' "$settings" >/dev/null; then
  unset CLAUDE_CONFIG_DIR
else
  export CLAUDE_CONFIG_DIR="$store"
fi
unset ANTHROPIC_API_KEY
if /usr/bin/node -e 'require("node:fs").openSync(process.argv[1], "r+")' "$store/CLAUDE.md"; then
  echo 'ERROR: instructions are writable' >&2; exit 1
fi
if rm "$store/CLAUDE.md"; then
  echo 'ERROR: instructions were removable; restore them before restart' >&2; exit 1
fi
claude auth status
EOS
```

### Update

**Role: operator**, during `docs/operations/update-assistant.md`.

Run the coding-agent package update through its own package-scoped maintenance window:

```sh
sudo /usr/local/sbin/alignfirst-assistant-maintenance packages -- \
  /opt/{{SERVICE_USER}}/libexec/admin-npm install -g @anthropic-ai/claude-code@latest
sudo -H -u {{SERVICE_USER}} bash -lc '
PROJECT_SHELL=/opt/{{SERVICE_USER}}/libexec/project-shell \
DEFAULT_NODE=<default-node-version> PINNED_NODE=<project-node-version> \
CODING_AGENT=claude \
  /opt/{{SERVICE_USER}}/libexec/check-project-runtimes.sh
'
```

The `skills` scope covers every inventoried native skills directory. Repeat the shared-install/native-copy block in [Skills](#skills) inside that window to refresh real copies, preserving executable bits.

### Verification

These host-side acceptance procedures are separate from offline template tests. Repeat authentication/permission checks for every provisioned store. Verify the recorded profile as well as `agent: claude` in delegated session files.

After the seed and the gateway start (`04-openclaw.md`):

```sh
sudo -i -u {{SERVICE_USER}} -- bash -lc 'aligndev code --help | grep selected'   # names claude as the agent
sudo -i -u {{SERVICE_USER}} -- bash -lc 'aligndev guide project >/dev/null && echo projects-ok'
sudo -i -u {{SERVICE_USER}} -- bash -lc 'npx -y skills list -g --json'        # 2 skills
```

Exercise the runtime harness through the real gateway. This catches shell-snapshot state that a direct invocation cannot reproduce:

```sh
sudo -H -u {{SERVICE_USER}} bash <<'EOF'
runtime_prompt='Run this read-only command with exec: PROJECT_SHELL=/opt/{{SERVICE_USER}}/libexec/project-shell DEFAULT_NODE=<default-node-version> PINNED_NODE=<project-node-version> CODING_AGENT=claude /opt/{{SERVICE_USER}}/libexec/check-project-runtimes.sh. Reply exactly RUNTIME_OK when it passes. Otherwise reply RUNTIME_CHECK_FAILED and include the failure output.'
/opt/{{SERVICE_USER}}/bin/openclaw agent --agent main \
  --session-id "$(cat /proc/sys/kernel/random/uuid)" \
  --message "$runtime_prompt" --json
EOF
```

The private turn must return `RUNTIME_OK`.

The surface smoke test in `07-channel.md` delegates a read-only run from the channel; its session file under `.plans/**/_aligndev/*.md` records `agent: claude`.
