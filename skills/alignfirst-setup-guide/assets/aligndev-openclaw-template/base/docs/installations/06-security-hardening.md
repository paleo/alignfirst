---
title: Security Hardening
read_when:
  - locking the service account's configuration, workspace, skills and packages
  - a write by the service account fails with "Operation not permitted" or EACCES
  - stopping the assistant immediately (kill switch)
---

# Security Hardening

**Operator**, last in the execution order: after [04-openclaw.md](04-openclaw.md), [07-channel.md](07-channel.md) and [08-coding-agent.md](08-coding-agent.md), because it locks paths those runbooks write. The surface smoke test of `07` follows.

<!-- DEV_SERVER_GATEWAY_SECTION -->
[09-dev-server-gateway.md](09-dev-server-gateway.md) also runs before this runbook.
<!-- DEV_SERVER_GATEWAY_SECTION -->

> **Note:** Commands shown are for Ubuntu 24.04. Adapt package, firewall, filesystem, and service-manager commands for another Linux server when needed.

`{{SERVICE_USER}}` has no sudo, so filesystem permissions are a guarantee, not an instruction. Two mechanisms: `chattr +i` (the owner can neither modify nor delete the file; only root removes the flag), and ownership handoff to `root` or `{{SERVER_ADMIN_USER}}` with the write bits stripped. Each locked directory root that sits in a service-writable parent is flagged as well; otherwise the tree could be renamed and recreated writable.

The assistant can no longer edit managed instructions or protected global packages. Its improvement path is a proposal, reviewed and applied through this repository. Memory, sessions, logs, `workspace/scratch/`, and project-runtime globals stay writable.

Pi's sole approved executable-declaration exception is native `<agent-dir>/auth.json`. It stays private, service-owned and replaceable, including adjacent lock operations, for normal OAuth login and automatic credential/refresh-token renewal. It can contain executable API-key commands; any same-UID process can persist such commands for later execution as that account. This is account-level persistence, not administrator privilege escalation. Permissions cannot distinguish renewal from another same-UID write. Project trust is not a sandbox.

## Install the maintenance controls

Install the kill switch and maintenance wrapper outside the service account's writable paths, then contain the assistant before changing the hardening policy:

```sh
sudo install -m 755 -o root -g root \
  ~/{{ADMIN_REPOSITORY_NAME}}/infra/openclaw/bin/assistant-kill.sh \
  /usr/local/sbin/alignfirst-assistant-kill
sudo install -m 755 -o root -g root \
  ~/{{ADMIN_REPOSITORY_NAME}}/infra/openclaw/bin/assistant-maintenance.sh \
  /usr/local/sbin/alignfirst-assistant-maintenance
sudo install -d -m 755 -o root -g root /opt/{{SERVICE_USER}}/libexec
sudo install -m 644 -o root -g root \
  ~/{{ADMIN_REPOSITORY_NAME}}/infra/openclaw/deployment-profiles.mjs \
  ~/{{ADMIN_REPOSITORY_NAME}}/infra/openclaw/deployment-policy.mjs \
  /opt/{{SERVICE_USER}}/libexec/
sudo /usr/local/sbin/alignfirst-assistant-kill
```

Keep both deployment helpers together: policy imports inventory by relative path. The root-owned copies must match the maintenance wrapper and backup script before opening a window.

## Configuration and workspace files

The workspace was applied during `04`. If it has changed since then, run [update-workspace.md](../operations/update-workspace.md), then rerun the kill switch before continuing.

```sh
sudo chown {{SERVICE_USER}}:{{SERVICE_USER}} /home/{{SERVICE_USER}}/.openclaw/openclaw.json \
  /home/{{SERVICE_USER}}/.openclaw/workspace/{AGENTS,IDENTITY,SOUL,USER}.md
sudo chmod 600 /home/{{SERVICE_USER}}/.openclaw/openclaw.json
sudo chmod 644 /home/{{SERVICE_USER}}/.openclaw/workspace/{AGENTS,IDENTITY,SOUL,USER}.md
sudo chattr +i /home/{{SERVICE_USER}}/.openclaw/openclaw.json \
  /home/{{SERVICE_USER}}/.openclaw/workspace/{AGENTS,IDENTITY,SOUL,USER}.md
```

Accepted gap: the heartbeat checklist is the `heartbeat:main` cron job's scratch, a SQLite row ([04 § 7](04-openclaw.md#heartbeat-scratch)). No flag protects it; the assistant can rewrite it through `heartbeat_respond` or `openclaw cron scratch --set`. It joins the assistant-written state the policy tolerates (memory, sessions), its reach is the daily tick, and [update-assistant.md](../operations/update-assistant.md#smoke-test) restores it.

The projects marker is repository-managed and immutable:

```sh
sudo chown root:root /home/{{SERVICE_USER}}/projects/.alignfirst-projects.json
sudo chmod 644 /home/{{SERVICE_USER}}/projects/.alignfirst-projects.json
sudo chattr +i /home/{{SERVICE_USER}}/projects/.alignfirst-projects.json
```

So are the aligndev settings (`~/.alignfirst/aligndev.settings.json`), with their directory `~/.alignfirst/`. Protect the directory as well as the file against parent replacement. The native policy below also protects service-home anchors; neither measure replaces the other.

```sh
sudo chown root:root /home/{{SERVICE_USER}}/.alignfirst/aligndev.settings.json
sudo chmod 644 /home/{{SERVICE_USER}}/.alignfirst/aligndev.settings.json
sudo chattr +i /home/{{SERVICE_USER}}/.alignfirst/aligndev.settings.json
sudo chown root:root /home/{{SERVICE_USER}}/.alignfirst
sudo chmod 755 /home/{{SERVICE_USER}}/.alignfirst
sudo chattr +i /home/{{SERVICE_USER}}/.alignfirst
```

The seed's `~/.alignfirst/companions/` stays service-owned, its companion registry included. The locked parent keeps it in place, and the assistant registers a project and creates its companion there on its own.

## Skills and instructions

The setup guide and `sharp-writing` under `~/.agents/skills/` feed both OpenClaw and the delegated coding agent. OpenClaw's managed `~/.openclaw/skills/` holds no skill: the playbook ships in `aligndev` and prints through `aligndev guide`. That directory stays locked so the assistant cannot install a skill there. The commands below protect both trees from service-account writes: admin ownership and modes prevent content changes; the immutable flag on each root prevents its removal or replacement. Both agents can still read the files. `~/.openclaw` stays writable for gateway state.

```sh
sudo chown -Rh {{SERVER_ADMIN_USER}}:{{SERVER_ADMIN_USER}} /home/{{SERVICE_USER}}/.agents
sudo find /home/{{SERVICE_USER}}/.agents -type d -exec chmod 755 {} +
sudo find /home/{{SERVICE_USER}}/.agents -type f -perm /111 -exec chmod 755 {} +
sudo find /home/{{SERVICE_USER}}/.agents -type f ! -perm /111 -exec chmod 644 {} +
sudo chattr +i /home/{{SERVICE_USER}}/.agents
sudo mkdir -p /home/{{SERVICE_USER}}/.openclaw/skills
sudo chown -Rh {{SERVER_ADMIN_USER}}:{{SERVER_ADMIN_USER}} /home/{{SERVICE_USER}}/.openclaw/skills
sudo find /home/{{SERVICE_USER}}/.openclaw/skills -type d -exec chmod 755 {} +
sudo find /home/{{SERVICE_USER}}/.openclaw/skills -type f -perm /111 -exec chmod 755 {} +
sudo find /home/{{SERVICE_USER}}/.openclaw/skills -type f ! -perm /111 -exec chmod 644 {} +
sudo chattr +i /home/{{SERVICE_USER}}/.openclaw/skills
```

### Native profile resources and anchors

Review the complete inventory, then apply the shared policy once for every provisioned store, including custom paths and optional quota stores:

```sh
sudo /usr/bin/node /opt/{{SERVICE_USER}}/libexec/deployment-profiles.mjs \
  /home/{{SERVICE_USER}}/.alignfirst/aligndev.settings.json \
  /home/{{SERVICE_USER}} /home/{{SERVICE_USER}}/.alignfirst/aligndev.settings.json
sudo /usr/bin/node /opt/{{SERVICE_USER}}/libexec/deployment-policy.mjs harden \
  /home/{{SERVICE_USER}}/.alignfirst/aligndev.settings.json \
  /home/{{SERVICE_USER}} /home/{{SERVICE_USER}}/.alignfirst/aligndev.settings.json
```

For Claude/Codex, this protects inventoried instructions and skills; it does not certify every native configuration surface. For Pi, it protects settings/models/MCP/keybindings declarations, saved trust, alternate context names, system/appended prompts, extensions, skills, prompts/themes, native `bin`, `agents`, npm/git package trees, and declared local resource roots. Existing executables retain executable modes. Install declared npm packages into the native managed npm directory before hardening; legacy global fallback, escaping manifest resources and discovery globs are refused.

The helper reserves absent context alternatives, including `AGENTS.override.md`, as immutable directory sentinels. The pinned context loader skips them. Empty `SYSTEM.md` and `APPEND_SYSTEM.md` preserve the normal prompt; an empty override instruction file would mask other instructions and is not equivalent. Do not replace sentinels manually.

The helper makes native roots and their ancestors up to the service home root-owned, service-group writable and sticky (`1770`). Root-owned protected children cannot be renamed through these anchors, while the service account can create ordinary files, replace its `auth.json`, and create adjacent locks. It removes immutable flags from these writable anchors. Never recursively freeze the entire Pi directory or home, recursively hand ownership back to the service user, or apply a blanket file mode to executable package trees. Managed anchors and non-package resources reject symlinks and hardlinks. Package-tree links are allowed only when every resolved target remains inside the same package tree; escapes, cycles and dangling links fail closed. Padded native paths, `file:` URLs, unsafe overlaps and mutable-state declarations are rejected before privileged changes.

Authenticate and save approved parent trust before this step ([08-coding-agent.md](08-coding-agent.md)). New managed paths or changed declarations require the appropriate maintenance scopes.

## Runtime launchers

The launchers and initialization files under `/opt/{{SERVICE_USER}}/` are root-owned. The gateway drop-in remains service-owned because `openclaw gateway install` refuses a unit definition owned by another user.

```sh
sudo chown -R root:root /opt/{{SERVICE_USER}}
sudo find /opt/{{SERVICE_USER}} -type d -exec chmod 755 {} +
sudo chmod 755 /opt/{{SERVICE_USER}}/bin/openclaw \
  /opt/{{SERVICE_USER}}/libexec/project-shell \
  /opt/{{SERVICE_USER}}/libexec/admin-npm \
  /opt/{{SERVICE_USER}}/libexec/check-project-runtimes.sh
sudo chmod 644 /opt/{{SERVICE_USER}}/libexec/init.bash
sudo chown {{SERVICE_USER}}:{{SERVICE_USER}} \
  /home/{{SERVICE_USER}}/.config/systemd/user/openclaw-gateway.service.d/20-system-node-path.conf
sudo chmod 644 \
  /home/{{SERVICE_USER}}/.config/systemd/user/openclaw-gateway.service.d/20-system-node-path.conf
```

## Global packages

`~/.npm-system-global/` holds `openclaw`, the coding agent, `alignfirst`, `aligndev` and `ctx7`. It is root-owned and immutable. A global install by the service account instead lands in its selected fnm runtime. The audited PATH keeps that writable runtime from shadowing `openclaw`, `aligndev` or the coding agent.

```sh
sudo chown -R root:root /home/{{SERVICE_USER}}/.npm-system-global
sudo chmod -R go-w /home/{{SERVICE_USER}}/.npm-system-global
sudo chattr +i /home/{{SERVICE_USER}}/.npm-system-global
```

### Project-runtime audit

Accepted trade-off: the service-writable fnm bin precedes system tools in project shells, so it can shadow commands such as `git`, `curl` or `ssh` for the same Linux user. The protected CLI paths stay ahead of it. This is an operational audit, not an integrity guarantee for service-owned tools.

Inspect every installed runtime, including inactive versions. The bin listing exposes manually added files and symlinks as well as npm-installed commands; compare the package listing with the development tools intended for that version:

```sh
sudo -H -u {{SERVICE_USER}} bash --noprofile --norc <<'EOS'
set -e
audit_status=0
for runtime in "$HOME"/.local/share/fnm/node-versions/*/installation; do
  [ -d "$runtime" ] || continue
  printf '\nRuntime: %s\n' "$runtime"
  /usr/bin/find "$runtime/bin" -mindepth 1 -maxdepth 1 -printf '%f -> %l\n' || audit_status=1
  /usr/bin/node /usr/lib/node_modules/npm/bin/npm-cli.js --prefix "$runtime" ls -g --depth=0 || audit_status=1
done
exit "$audit_status"
EOS
```

## Unlocking for maintenance

Use `/usr/local/sbin/alignfirst-assistant-maintenance`. It accepts only named scopes: `config`, `workspace`, `packages`, `skills`, `projects`, `instructions`, `agent-skills` and `agent-config`. The `config` scope covers `openclaw.json` and the aligndev settings with their directory `~/.alignfirst/`. The native scopes cover every inventoried profile/store, not just `code.profile`: `instructions` covers managed context/system files, `agent-skills` native skills, and `agent-config` Pi declarations, trust, executable helpers, packages and other resources. `skills` also covers native skills. Before an unlock, the wrapper validates paths, contains the account and refreshes `~/seed/` from this repository. It saves resolved admin/deployed inventories in a root-private directory so original resources remain tracked when declarations change. Its `EXIT` trap contains the account again before restoring ownership, modes and immutable flags on success, failure or interruption. Failed recontainment aborts privileged cleanup and leaves gateway state unknown. Failed cleanup retains the inventory path for [operator recovery](../operations/recover-assistant.md#failed-maintenance-cleanup); never pass it to a service-account command.

The operation runbooks supply the scopes and service-account command. Start the gateway only after the wrapper reports that hardening was restored and exits 0.

## Kill switch

The installed kill switch stops the gateway, stops and kills every rootless container, then terminates every service-account process regardless of its executable name. Only the `systemd --user` manager and its `(sd-pam)` process may survive. The script fails when a container, the gateway or another process survives.

```sh
sudo /usr/local/sbin/alignfirst-assistant-kill
# recovery:
sudo -i -u {{SERVICE_USER}} -- systemctl --user start openclaw-gateway
```

## Deployment acceptance

These host-side checks are separate from offline fixture tests. Run them on the deployment host and record actual results; template tests do not prove OS permission enforcement, live OAuth renewal, channel behavior or reboot recovery.

As the service account, every write must fail with `Operation not permitted` or `Permission denied`:

```sh
sudo -H -u {{SERVICE_USER}} bash -lc 'echo x >> ~/.openclaw/workspace/AGENTS.md'
sudo -H -u {{SERVICE_USER}} bash -lc 'echo x >> ~/.openclaw/openclaw.json'
sudo -H -u {{SERVICE_USER}} bash -lc 'echo x >> ~/projects/.alignfirst-projects.json'
sudo -H -u {{SERVICE_USER}} bash -lc 'echo x >> ~/.alignfirst/aligndev.settings.json'
sudo -H -u {{SERVICE_USER}} bash -lc 'mv ~/.alignfirst ~/.alignfirst-x'
sudo -H -u {{SERVICE_USER}} bash -lc 'mv ~/.alignfirst/companions ~/.alignfirst/companions-x'
sudo -H -u {{SERVICE_USER}} bash -lc 'touch ~/.openclaw/skills/probe'
sudo -H -u {{SERVICE_USER}} bash -lc 'mv ~/.agents ~/.agents-x'
sudo -H -u {{SERVICE_USER}} bash -lc 'mv ~/.openclaw/skills ~/.openclaw/skills-x'
```

A project-runtime global install must succeed and leave the protected launcher selected. The trap removes the test package on success or failure. If this runtime already contains `cowsay`, use a clean test runtime to preserve that installation:

```sh
sudo -H -u {{SERVICE_USER}} bash -l <<'EOS'
set -e
cd "$HOME"
runtime_prefix=$(readlink -f "${FNM_MULTISHELL_PATH:?}")
npm_prefix=$(npm prefix -g)
test "$(readlink -f "$npm_prefix")" = "$runtime_prefix"
test ! -e "$(npm root -g)/cowsay"
test ! -L "$(npm root -g)/cowsay"
for name in cowsay cowthink; do
  test ! -e "$runtime_prefix/bin/$name" && test ! -L "$runtime_prefix/bin/$name"
done
trap 'npm uninstall -g cowsay' EXIT
npm install -g cowsay
test "$(command -v openclaw)" = /opt/{{SERVICE_USER}}/bin/openclaw
command -v openclaw
EOS
# Expected: /opt/{{SERVICE_USER}}/bin/openclaw
sudo -i -u {{SERVICE_USER}} -- /opt/{{SERVICE_USER}}/libexec/admin-npm ls -g --depth=0
# Expected: the reviewed deployment inventory, including any explicit quota CLI
sudo -H -u {{SERVICE_USER}} bash -lc '
PROJECT_SHELL=/opt/{{SERVICE_USER}}/libexec/project-shell \
DEFAULT_NODE=<default-node-version> PINNED_NODE=<project-node-version> \
CODING_AGENT=<claude|codex|pi> \
  /opt/{{SERVICE_USER}}/libexec/check-project-runtimes.sh
'
```

For each Pi store from the inventory, verify as the real service UID that protected files cannot be opened for writing and that managed anchors cannot be renamed, unlinked or replaced through any ancestor. Include alternate context sentinels, `trust.json`, `settings.json`, native `bin`, package executables and declared external roots. Stop if any protected operation succeeds. Confirm root-owned sticky `1770` anchors with `stat`, and immutable resource flags with `lsattr`.

Check every Pi store's anchor modes and ordinary adjacent lock writes without reading credentials:

```sh
sudo -H -u {{SERVICE_USER}} bash -l <<'EOS'
set -eo pipefail
/usr/bin/node /opt/{{SERVICE_USER}}/libexec/deployment-profiles.mjs \
  "$HOME/.alignfirst/aligndev.settings.json" "$HOME" \
  "$HOME/.alignfirst/aligndev.settings.json" |
  jq -r '.stores[] | select(.agent == "pi") | .configDir' |
  while IFS= read -r store; do
    stat -c '%U:%G %a %n' "$HOME" "$store" "$store/settings.json" "$store/trust.json"
    test -w "$store"
    probe=$(mktemp "$store/.auth-lock-probe.XXXXXX")
    rm "$probe"
    if /usr/bin/node -e 'require("node:fs").openSync(process.argv[1], "r+")' "$store/settings.json"; then
      echo 'ERROR: managed Pi settings are writable' >&2; exit 1
    fi
  done
EOS
```

In an interactive Pi session using that store, verify `/login`, a real OAuth refresh, native adjacent auth lock creation/removal and session/cache writes; do not print credentials. The disposable lock probe alone does not prove the native renewal flow. Restart Pi in the approved parent and a new linked worktree to verify inherited saved trust. OpenClaw needs no `pi-background` for a Pi child. Test failed-command restoration before reopening the channel:

```sh
sudo /usr/local/sbin/alignfirst-assistant-maintenance instructions agent-skills agent-config -- false
# Expected: nonzero exit, restored policy, gateway stopped. Inspect ownership/flags again.
sudo -i -u {{SERVICE_USER}} -- systemctl --user is-active openclaw-gateway
# Expected: inactive
```

Still working: reads of the instructions, skills and project listing; writes under `~/.openclaw/workspace/scratch/`; project-level and fnm-runtime global npm installs; the coding agent's authentication and session state.

Rootless podman closes the bind-mount bypass: container root maps to the service account, which cannot override the flag.

```sh
sudo -H -u {{SERVICE_USER}} bash -lc 'podman run --rm -v ~/.openclaw/openclaw.json:/x:rw docker.io/library/alpine sh -c "echo x >> /x"'
# Expected: cannot create /x: Operation not permitted
```

After a reboot, the flags survive and the gateway and `podman.socket` return through lingering:

```sh
sudo lsattr /home/{{SERVICE_USER}}/.openclaw/openclaw.json /home/{{SERVICE_USER}}/.openclaw/workspace/*.md
sudo -i -u {{SERVICE_USER}} -- systemctl --user is-active openclaw-gateway podman.socket
```

Finish with the selected agent's verification/acceptance section in [08-coding-agent.md](08-coding-agent.md), a private backup/recovery rehearsal ([recover-assistant.md](../operations/recover-assistant.md)), then the smoke test of [07-channel.md](07-channel.md).

Start the gateway before that smoke test:

```sh
sudo -i -u {{SERVICE_USER}} -- systemctl --user start openclaw-gateway
```
