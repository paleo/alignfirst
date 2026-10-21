---
title: Pi Setup
read_when:
  - installing, authenticating, protecting or updating Pi in either account
  - checking Pi runtime selection, project trust or isolated subagents
---

# Pi Setup

Position: after `04-openclaw.md`, before `06-security-hardening.md`. [Admin Account](#admin-account) runs during `01-server-setup.md`; [Install](#install) runs during `03-toolchain.md` after the other protected npm CLIs are installed.

OpenClaw is the persistent parent. The `service-pi` profile selects Pi explicitly, independently of parent detection and OpenClaw's conversational model. It uses provider `{{PI_PROVIDER}}`, model `{{PI_MODEL}}`, native directory {{PI_CONFIG_DIR_DISPLAY}}, and authentication method **{{PI_AUTH_METHOD}}**. The optional quota source in `infra/openclaw/aligndev.settings.json` belongs to its separately authenticated native CLI account; AlignDev does not verify that account against Pi's.

## Admin Account

**Role: human**, in the `{{SERVER_ADMIN_USER}}` shell, at the end of `01-server-setup.md`.

Install the reviewed npm release using an admin-account Node satisfying Pi's minimum, **22.19.0**. The independent `pi-subagent` package has the same minimum. AlignDev's own Node requirement is separate; continue to satisfy the toolchain runbook too.

```sh
node --version
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@1.3.0
pi --version
```

> **User action required.** Start `pi` in the admin home and run `/login` for the selected provider. Authenticate the operator's own account. Its default native directory is `~/.pi/agent`; a custom admin directory must be selected explicitly with `PI_CODING_AGENT_DIR`. It does not share the service account's credentials.

Start Pi in the admin repository to continue the installation. Pi discovers project skills under `.agents/skills/`, so the repository-local `sysadmin` skill belongs there. The service account receives no sysadmin skill or sudo rights.

## Service Account

### Install

**Role: operator**, after the protected npm prefix and `admin-npm` exist. Run these installation commands only on the deployment host, never from a support session.

```sh
sudo -i -u {{SERVICE_USER}} -- /opt/{{SERVICE_USER}}/libexec/admin-npm install -g \
  --ignore-scripts @earendil-works/pi-coding-agent@1.3.0
sudo install -o root -g root -m 755 infra/openclaw/node-runtime/pi-launcher.mjs \
  /opt/{{SERVICE_USER}}/libexec/pi-launcher.mjs
sudo install -o root -g root -m 755 infra/openclaw/node-runtime/install-pi-launcher.sh \
  /opt/{{SERVICE_USER}}/libexec/install-pi-launcher.sh
# Complete all protected-prefix installations before locking this anchor.
sudo chown -R root:root /home/{{SERVICE_USER}}/.npm-system-global
sudo chmod -R go-w /home/{{SERVICE_USER}}/.npm-system-global
sudo chattr +i /home/{{SERVICE_USER}}/.npm-system-global
sudo /opt/{{SERVICE_USER}}/libexec/install-pi-launcher.sh 1.3.0
set -o pipefail
settings=infra/openclaw/aligndev.settings.json
store=$(sudo /usr/bin/node infra/openclaw/deployment-profiles.mjs "$settings" \
  /home/{{SERVICE_USER}} /home/{{SERVICE_USER}}/.alignfirst/aligndev.settings.json | jq -er '.configDir') || exit 1
native_default=$(jq -r '.code.profiles[.code.profile].configDir == null' "$settings")
sudo -H -u {{SERVICE_USER}} bash -lc '
  if [ "$1" = true ]; then unset PI_CODING_AGENT_DIR; else export PI_CODING_AGENT_DIR="$2"; fi
  command -v pi; PI_OFFLINE=1 pi --version
' bash "$native_default" "$store"
# Expected executable: /opt/{{SERVICE_USER}}/bin/pi
```

The installer verifies the exact package name/version and its declared `bin.pi`; Pi 1.3.0 declares `dist/bundle/cli.js`. It rejects missing, escaping or symlinked CLI paths, unsupported system Node, and an unprotected package prefix. The generated root-owned launcher uses `exec /usr/bin/node <verified-entry> "$@"`. It preserves arguments, cwd, environment and PATH. It does not invoke fnm, reset PATH or install another Node.

Pi's native shell helper prepends `<agent-dir>/bin` for tools. That directory is a protected executable resource; do not put a Node override there. Provision approved `rg`/`fd` binaries there or on system PATH before hardening, since Pi otherwise downloads missing tools into that bin. Later replacements use `agent-config` maintenance. With it protected, project commands retain the project-selected Node while Pi and packaged subagents use the launcher's Node through `process.execPath`.

### Authenticate

**Role: human**, after `04-openclaw.md`. The seed inventories `configDir` against the service home and the deployed settings location. `~/.pi/agent` is the default; a selected custom store uses the same seed, maintenance and backup inventory. Keep it isolated beneath the service home. Do not point it at another account or use symlinked anchors/non-package resources. Package-tree links must remain wholly contained in that tree; padded paths and `file:` URLs are rejected.

Open an interactive service-account shell and select the rendered store:

```sh
sudo -i -u {{SERVICE_USER}}
# Resolve ~/ and relative values using the deployed settings, not the operator cwd/home.
set -o pipefail
settings="$HOME/.alignfirst/aligndev.settings.json"
store=$(/usr/bin/node /opt/{{SERVICE_USER}}/libexec/deployment-profiles.mjs \
  "$settings" "$HOME" "$settings" | jq -er '.configDir') || exit 1
if jq -e '.code.profiles[.code.profile].configDir == null' "$settings" >/dev/null; then
  unset PI_CODING_AGENT_DIR
else
  export PI_CODING_AGENT_DIR="$store"
fi
pi
```

> **User action required.** Run `/login` and select `{{PI_PROVIDER}}` using the chosen **{{PI_AUTH_METHOD}}** flow. Enter credentials only in Pi's native prompt. For environment authentication, provision the provider's documented variable privately into the process that launches Pi; never put its value in profile `env`, the repository, seed files, chat or shell history.

Exit Pi, then check readiness without printing credentials:

```sh
pi auth check --provider '{{PI_PROVIDER}}' --json
exit
```

Do not use `--credentials` or credential-printing commands in reports. When selecting environment authentication, remove an obsolete stored provider credential through `/logout` first; Pi prefers stored credentials to environment keys. `configDir: null` removes inherited `PI_CODING_AGENT_DIR`; a string sets its resolved explicit path. Both have absolute filesystem inventory paths. Apply routing after login-shell initialization for every native command, including trust, package installation and readiness checks. Reproduce the selected profile's additional `env`/`unset`, cwd and credential routing.

For optional Claude/Codex quota, install that CLI separately, then authenticate each original quota selection. The loop preserves null/string mode even when filesystem inventory deduplicates stores. These subscription-login commands remove API-key routes; adapt additional quota `env`/`unset` privately before running them. Quota readiness does not establish Pi account identity.

```sh
sudo -H -u {{SERVICE_USER}} bash -l <<'EOS'
set -eo pipefail
settings="$HOME/.alignfirst/aligndev.settings.json"
/usr/bin/node /opt/{{SERVICE_USER}}/libexec/deployment-profiles.mjs \
  "$settings" "$HOME" "$settings" >/dev/null
jq -c '.code.profiles[] | .quota? | select(.source == "claude" or .source == "codex")' \
  "$settings" | while IFS= read -r launch; do
    source=$(jq -r '.source' <<<"$launch")
    case "$source" in
      claude) variable=CLAUDE_CONFIG_DIR; native=.claude ;;
      codex) variable=CODEX_HOME; native=.codex ;;
    esac
    store=$(/usr/bin/node -e '
      const {resolve, dirname} = require("node:path");
      const value = JSON.parse(process.argv[1]).configDir;
      console.log(value === null ? resolve(process.env.HOME, process.argv[3]) :
        value.startsWith("~/") ? resolve(process.env.HOME, value.slice(2)) :
        resolve(dirname(process.argv[2]), value));' "$launch" "$settings" "$native")
    if jq -e '.configDir == null' <<<"$launch" >/dev/null; then
      unset "$variable"
    else
      export "$variable=$store"
    fi
    mkdir -p "$store"
    case "$source" in
      claude) unset ANTHROPIC_API_KEY
        claude auth login --claudeai < /dev/tty
        claude auth status ;;
      codex) unset CODEX_API_KEY OPENAI_API_KEY
        codex login --device-auth < /dev/tty
        codex login status ;;
    esac
  done
EOS
```

Complete interactive login at the private terminal. `/dev/tty` keeps authentication input separate from the settings loop.

A protected native `settings.json` cannot save interactive preferences outside maintenance. Native `auth.json` remains private, service-owned and replaceable; adjacent authentication locks and sessions/caches stay writable. The approved exception allows executable API-key commands in `auth.json`: another process under the same UID can persist commands there. This is account-level persistence, not administrator privilege escalation. Permissions cannot distinguish a refresh from another same-UID write.

### Skills and Optional Subagents

**Role: operator**, before hardening. Install shared skills into their canonical `~/.agents/skills` root; Pi discovers it natively, including with a custom agent directory. Avoid native symlink aliases that the deployment's managed-path validation rejects.

```sh
sudo -i -u {{SERVICE_USER}} -- bash -lc '
  npx -y skills add https://github.com/paleo/alignfirst --global --yes \
    --agent universal --skill alignfirst-setup-guide < /dev/null
  npx -y skills add https://github.com/paleo/skills --global --yes \
    --agent universal --skill sharp-writing < /dev/null
'
```

Offer `@alignfirst/pi-subagent` only after explicit approval. Repeat the [Authenticate](#authenticate) shell and null/string routing, then review existing packages/extensions and `agents/` profiles under its absolute `$store` path. In that same routed shell, install one reviewed, version-pinned npm package using `pi install npm:@alignfirst/pi-subagent@<approved-version>`. Preserve user subagent profiles and remove no existing declaration without approval. Verify exactly one `subagent` tool and the package identity `@alignfirst/pi-subagent`, without a `:dist` suffix. The settings declaration and package/resource trees become protected. OpenClaw does not require `pi-background` to delegate to Pi.

After hardening, use the `agent-config` maintenance scope for approved package/declaration changes; use `agent-skills` for native skills and `instructions` for managed instructions. A package that also installs skills needs both scopes. Keep the gateway stopped until policy restoration succeeds.

### Saved Parent Trust

**Role: human**, under the same service account and selected native store. Agree on one dedicated parent containing the project and all linked worktrees. Record its actual canonical path in the onboarding report. Arrange the layout with the operator when needed; do not silently broaden trust to all `~/projects`.

Repeat the [Authenticate](#authenticate) shell and null/string routing, change to that approved parent, start `pi`, run `/trust`, select **Trust**, and restart under the same routing. From an immediate child, **Trust parent folder** is equivalent. The nearest saved decision in `<agent-dir>/trust.json` wins. Complete this before hardening; later changes use `agent-config` maintenance. Do not set `defaultProjectTrust: "always"` or add `--approve` to delegation.

Future resources beneath that parent inherit trust. Project trust controls discovery, not filesystem access or the safety of project resources. Every provisioned profile is available to the service account; the editable registry routes work and is not account authorization.

### Instructions and Hardening

The seed merges `infra/openclaw/coding-agent/AGENTS.md` into each inventoried Pi instruction file between managed markers, preserving surrounding text. It does not overwrite native settings or user `agents/` profiles. Validation selects every provisioned profile explicitly, independent of the seed cwd's registry selection.

Follow `06-security-hardening.md` for the shared resource policy. Managed context variants, system prompts, settings/models/MCP declarations, trust, extensions, skills, prompts/themes, bin and installed packages need protected anchors as well as protected contents. Keep executable modes in package trees. Use the shared inventory for custom stores, backup destination mapping and recovery; keep backups private.

### Update

**Role: operator**, during `docs/operations/update-assistant.md`. Review an exact release before changing the pin. Run its npm update through the package maintenance window, then regenerate the launcher after hardening is restored:

```sh
sudo /usr/local/sbin/alignfirst-assistant-maintenance packages -- \
  /opt/{{SERVICE_USER}}/libexec/admin-npm install -g --ignore-scripts \
  @earendil-works/pi-coding-agent@<reviewed-version>
sudo /opt/{{SERVICE_USER}}/libexec/install-pi-launcher.sh <reviewed-version>
```

A changed or unrecognized `engines.node` range requires review rather than an automatic fallback. Do not use Pi's self-updater or a second managed installer for this protected npm installation.

### Deployment Acceptance

These are host-side procedures, not claims about the offline template checks:

- Run `aligndev guide code --profile service-pi`; confirm the selected store/model and credential readiness without revealing secrets.
- Run the runtime checker directly and through the private gateway procedure in the base runbooks with `CODING_AGENT=pi`. Pi must resolve to `/opt/{{SERVICE_USER}}/bin/pi`; its no-model runtime probe must retain the project child runtime.
- Verify an approved parent and a future worktree inherit the saved decision after restart. Confirm duplicate subagent tools are absent and existing user profiles remain intact.
- As the real service UID, verify managed resources cannot be rewritten, unlinked or replaced, including through their parents; confirm authentication locks/renewal and ordinary session/cache writes still work.
- Exercise failed-command maintenance restoration, private backup/recovery, a channel delegation and reboot recovery separately. Do not restart the gateway after incomplete hardening.
