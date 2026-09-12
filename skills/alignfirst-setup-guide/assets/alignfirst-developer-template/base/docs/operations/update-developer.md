---
title: Update the Developer
read_when:
  - upgrading OpenClaw, the coding agent, alignfirst, alcode, alproject, ctx7 or the skills
---

# Update the Developer

**Operator.** Every step is idempotent; re-apply all of them. Each maintenance window contains the developer before an unlock and leaves the gateway stopped. Configuration changes are a different runbook: [configure-developer.md](configure-developer.md).

Open a report in `.reports/` and record the versions the verify step prints.

## Maintenance controls

Pull the repository and reinstall its root-owned controls before opening any maintenance window:

```sh
cd ~/{{ADMIN_REPOSITORY_NAME}} && git pull
sudo install -m 755 -o root -g root infra/openclaw/bin/developer-kill.sh \
  /usr/local/sbin/alignfirst-developer-kill
sudo install -m 755 -o root -g root infra/openclaw/bin/developer-maintenance.sh \
  /usr/local/sbin/alignfirst-developer-maintenance
```

## Back up

Before a core bump, stop the gateway so both OpenClaw and the independent thread-handoff database
close consistently, then keep the state the migrations will rewrite
([recover-developer.md](recover-developer.md#restore)):

```sh
sudo -i -u {{SERVICE_USER}} -- systemctl --user stop openclaw-gateway
sudo -i -u {{SERVICE_USER}} -- /home/{{SERVICE_USER}}/seed/bin/backup.sh
```

## Project runtimes and launchers

Contain the account before replacing runtime files. The gateway stays stopped through the remaining steps:

```sh
sudo /usr/local/sbin/alignfirst-developer-kill
```

For the first upgrade from a shared system/project runtime, provision system Node using [01-server-setup.md](../installations/01-server-setup.md), then run the fnm installation and version-provisioning blocks in [03 § 2](../installations/03-toolchain.md#2-project-runtimes). Use Node 24.16.0 or newer as the fnm default for the developer CLIs. Complete provisioning before adding the profile hooks below; an unavailable default prevents login-shell startup. Existing hosts keep their installed project versions.

Refresh these root-owned files from the operator's checkout on every update, including the first migration. Refreshing `~/seed` alone does not deploy them:

```sh
cd ~/{{ADMIN_REPOSITORY_NAME}}
sudo install -d -m 755 -o root -g root /opt/{{SERVICE_USER}}/bin /opt/{{SERVICE_USER}}/libexec
sudo install -m 755 -o root -g root infra/openclaw/bin/openclaw /opt/{{SERVICE_USER}}/bin/openclaw
sudo install -m 755 -o root -g root \
  infra/openclaw/node-runtime/project-shell \
  infra/openclaw/node-runtime/admin-npm \
  infra/openclaw/node-runtime/check-project-runtimes.sh \
  /opt/{{SERVICE_USER}}/libexec/
sudo install -m 644 -o root -g root infra/openclaw/node-runtime/init.bash /opt/{{SERVICE_USER}}/libexec/init.bash
```

Remove only the legacy npm prefix setting and add missing profile hooks. Keep the existing login profile's environment bridge and custom settings. This shell bypasses the profiles while migrating them:

```sh
sudo -H -u {{SERVICE_USER}} bash --noprofile --norc <<'EOS'
set -e
if [ -f "$HOME/.npmrc" ]; then
  sed -i '/^[[:space:]]*prefix[[:space:]]*=/d' "$HOME/.npmrc"
fi
hook='. /opt/{{SERVICE_USER}}/libexec/init.bash'
grep -qxF "$hook" "$HOME/.bash_profile" || printf '\n%s\n' "$hook" >> "$HOME/.bash_profile"
hook='case $- in *i*) . /opt/{{SERVICE_USER}}/libexec/init.bash ;; esac'
grep -qxF "$hook" "$HOME/.bashrc" || printf '\n%s\n' "$hook" >> "$HOME/.bashrc"
EOS
```

The login hook must remain after the environment bridge and any PATH assignments. The [gateway step](#gateway-unit-and-restart) installs or refreshes the systemd drop-in before restarting.

## npm packages

The prefix is root-owned and immutable ([06](../installations/06-security-hardening.md)). The maintenance wrapper gives the service account this scope for the command, then restores root ownership, modes and the immutable flag through an `EXIT` trap. `openclaw update` is channel-aware and refreshes its plugins at the core's version; the other packages ride `@latest`.

```sh
sudo /usr/local/sbin/alignfirst-developer-maintenance packages -- bash -lc '
openclaw update --yes --no-restart --accept-capabilities
openclaw plugins list --json | grep -q "\"alignfirst-developer\"" &&
  openclaw plugins update @paleo/alignfirst-developer-openclaw-plugin@latest --accept-capabilities
/opt/{{SERVICE_USER}}/libexec/admin-npm install -g alignfirst@latest @paleo/alcode@latest @paleo/alproject@latest ctx7@latest
'
```

Immediately replace the projects marker, then validate with the new CLI. The wrapper refreshes the seed before each unlock and keeps the gateway stopped between these commands. The old marker's `portRange` key is rejected by the new CLI; individual project `.alignfirst.json` files retain their singular `portRange` claims:

```sh
sudo /usr/local/sbin/alignfirst-developer-maintenance projects -- bash -lc '
set -e
install -m 644 ~/seed/projects/.alignfirst-projects.json ~/projects/.alignfirst-projects.json
alproject doctor --root ~/projects
alproject list --root ~/projects
'
```

If interrupted after the package upgrade, complete marker replacement and validation before any inventory command or restart. For hosts still using the v1 registry, finish [the registry migration](#upgrade-from-the-registry-model) before continuing.

`--accept-capabilities` accepts the plugins' reviewed capability changes. Without it the post-update plugin sync stops with an unresolved review, which `openclaw update repair --accept-capabilities` finishes.

`alignfirst-developer` is an independent npm plugin, so its explicit update is separate from the core and
official channel-plugin update. The seed installs it the first time, in the re-seed step below, and
its state directory remains in place across package replacement. The explicit `@latest` replaces any older version pin in its tracked npm source.

Update the coding agent through its package-scoped command: [08-coding-agent.md § Update](../installations/08-coding-agent.md#update).

`openclaw update` exits 1 when its post-install doctor attempts a config write, which the immutable `openclaw.json` blocks (`ENOTDIR: not a directory, scandir '…/openclaw.json'`). Exit 0 means no write was attempted. Either way the package update succeeded; the verify step is what counts, and the migration step below finishes what the lock interrupted.

Verify — the listing must show exactly six packages (`openclaw`, the coding agent, `alignfirst`, `@paleo/alcode`, `@paleo/alproject`, `ctx7`); anything else is a stray from a mistyped install, to remove through another `packages` maintenance window:

```sh
sudo -i -u {{SERVICE_USER}} -- bash -lc 'openclaw --version && alignfirst --version && alcode --help >/dev/null && echo alcode-ok && alproject --version && ctx7 --version'
sudo -i -u {{SERVICE_USER}} -- /opt/{{SERVICE_USER}}/libexec/admin-npm ls -g --depth=0
sudo -H -u {{SERVICE_USER}} bash -lc '
PROJECT_SHELL=/opt/{{SERVICE_USER}}/libexec/project-shell \
DEFAULT_NODE=<default-node-version> PINNED_NODE=<project-node-version> \
ALIGNFIRST_CODE_AGENT=<claude|codex> \
  /opt/{{SERVICE_USER}}/libexec/check-project-runtimes.sh
'
```

Also run the [project-runtime audit](../installations/06-security-hardening.md#project-runtime-audit). It inventories writable runtime bins and globals across every installed version, separately from the protected six-package listing.

## Skills

The shared `~/.agents` tree and OpenClaw's managed `~/.openclaw/skills` tree are admin-owned and immutable. The `skills` scope also covers Claude Code's symlink tier when selected.

### Move the playbook to OpenClaw's skill directory

A deployment created before the playbook became OpenClaw-only runs this migration once, before the normal skill update. Removing the old entry deletes its canonical copy and every agent link. The second command copies it directly into OpenClaw's managed directory.

```sh
sudo /usr/local/sbin/alignfirst-developer-maintenance skills -- bash <<'EOS'
set -e
npx -y skills remove alignfirst-developer-openclaw-playbook -g -y </dev/null
npx -y skills add https://github.com/paleo/alignfirst --global --yes \
  --agent openclaw --copy --skill alignfirst-developer-openclaw-playbook </dev/null
EOS
```

Apply [update-workspace.md](update-workspace.md) so `AGENTS.md` reads the playbook from its new path. The maintenance wrapper restores `/home/{{SERVICE_USER}}/.openclaw/skills` with admin ownership, directory mode `755`, file mode `644` and the immutable flag, as specified in [06-security-hardening.md](../installations/06-security-hardening.md#skills-and-instructions).

### Update skills

```sh
sudo /usr/local/sbin/alignfirst-developer-maintenance skills -- \
  bash -lc 'npx -y skills update -g -y </dev/null'
```

The CLI does not retain the copied OpenClaw target during an update. Restore the playbook copy after every update:

```sh
sudo /usr/local/sbin/alignfirst-developer-maintenance skills -- bash -lc '
npx -y skills add https://github.com/paleo/alignfirst --global --yes \
  --agent openclaw --copy --skill alignfirst-developer-openclaw-playbook </dev/null
'
```

Then make sure every target exists. If an entry is missing, repeat the idempotent `skills add` block of [08-coding-agent.md § Skills](../installations/08-coding-agent.md#skills), replacing its opening command with:

```sh
sudo /usr/local/sbin/alignfirst-developer-maintenance skills -- bash <<'EOS'
```

Sweep the escaped symlinks the `skills` CLI writes into `~/.openclaw/skills/` ([gotchas.md](../gotchas.md#skills-cli-writes-escaped-symlinks-under-openclawskills)). Run it as a separate command: the symlink writes lag the CLI's return, so a sweep chained in the same heredoc deletes nothing.

```sh
sudo /usr/local/sbin/alignfirst-developer-maintenance skills -- \
  find /home/{{SERVICE_USER}}/.openclaw/skills -maxdepth 1 -type l -print -delete
```

Verify the playbook is a real directory and its old shared and coding-agent entries are absent:

```sh
sudo -i -u {{SERVICE_USER}} bash <<'EOS'
set -e
test -f ~/.openclaw/skills/alignfirst-developer-openclaw-playbook/SKILL.md
test ! -L ~/.openclaw/skills/alignfirst-developer-openclaw-playbook
for root in ~/.agents/skills ~/.codex/skills ~/.claude/skills; do
  test ! -e "$root/alignfirst-developer-openclaw-playbook"
  test ! -L "$root/alignfirst-developer-openclaw-playbook"
done
EOS
```

The setup guide and `sharp-writing` remain shared through `~/.agents/skills/`. Only OpenClaw automatically discovers the managed playbook. See [gotchas.md](../gotchas.md#shared-skills-live-under-agentsskills).

## Upgrade from the registry model

A host deployed before `@paleo/alproject` 2 has no marker yet; the `projects` scope tolerates its absence, so the command above creates it. Then remove the immutable registry and guide the old model installed:

```sh
sudo chattr -i /home/{{SERVICE_USER}}/.alproject.json /home/{{SERVICE_USER}}/projects/alproject-guide.md
sudo rm /home/{{SERVICE_USER}}/.alproject.json /home/{{SERVICE_USER}}/projects/alproject-guide.md
```

## Migrate after a core bump

A release can ship state migrations that only doctor's repair mode applies, with or without a TTY. `openclaw update repair` runs that repair, syncs the plugins at the core's version and refreshes the plugin registry; it needs the configuration and the workspace writable:

```sh
sudo /usr/local/sbin/alignfirst-developer-maintenance config workspace -- \
  openclaw update repair --yes --accept-capabilities
```

Read its output: every imported or removed file is a change to port into the repository.

## Re-seed

Re-seed after a core bump, and whenever the `git pull` above changed anything under `infra/openclaw/`: the seed is the configuration's source of truth, and a release that adds a plugin or a tool ships as a seed change. Re-seed through [configure-developer.md](configure-developer.md).

A new OpenClaw release can retire keys the seed sets, turn on new defaults and widen the channel plugin's declared capabilities. `config set` under the new binary rewrites the config in the current schema, and the surface module re-records the plugin consent. A `config set` that fails names a retired key; the trailing interactive `openclaw doctor` shows the new defaults. Port both into the seed modules before starting the gateway.

## Gateway unit and restart

After an OpenClaw version bump, doctor may report a unit installed by an older version. Refresh the unit and drop-in, then restart the contained gateway. `gateway install --force` may start it early, so `start` would preserve the old process environment. The installer refuses group-writable paths ([gotchas.md](../gotchas.md#gateway-install-refuses-group-writable-systemd-paths)), hence the `chmod`:

```sh
sudo install -d -m 755 -o {{SERVICE_USER}} -g {{SERVICE_USER}} \
  /home/{{SERVICE_USER}}/.config/systemd/user/openclaw-gateway.service.d
sudo -H -u {{SERVICE_USER}} bash -lc 'chmod go-w ~/.config ~/.config/systemd ~/.config/systemd/user ~/.config/systemd/user/openclaw-gateway.service ~/.config/systemd/user/openclaw-gateway.service.d'
sudo /usr/local/sbin/alignfirst-developer-maintenance config -- \
  openclaw gateway install --force
sudo install -m 644 -o {{SERVICE_USER}} -g {{SERVICE_USER}} \
  ~/{{ADMIN_REPOSITORY_NAME}}/infra/openclaw/node-runtime/gateway-path.conf \
  /home/{{SERVICE_USER}}/.config/systemd/user/openclaw-gateway.service.d/20-system-node-path.conf
sudo -i -u {{SERVICE_USER}} -- systemctl --user daemon-reload
sudo -i -u {{SERVICE_USER}} -- systemctl --user restart openclaw-gateway
sudo -i -u {{SERVICE_USER}} -- systemctl --user cat openclaw-gateway.service
sudo -i -u {{SERVICE_USER}} -- systemctl --user show -p KillMode --value openclaw-gateway.service
gateway_pid=$(sudo -i -u {{SERVICE_USER}} -- systemctl --user show -p MainPID --value openclaw-gateway.service)
sudo readlink -f "/proc/$gateway_pid/exe"
sudo cat "/proc/$gateway_pid/environ" | tr '\0' '\n' | grep -E '^(PATH|SHELL)='
# Expected: KillMode=mixed; /usr/bin/node; PATH has no fnm entry; SHELL is /opt/{{SERVICE_USER}}/libexec/project-shell
```

## Smoke test

`--non-interactive` reports without applying anything:

```sh
sudo -i -u {{SERVICE_USER}} -- openclaw doctor --non-interactive
sudo -i -u {{SERVICE_USER}} -- openclaw cron list --all
sudo -i -u {{SERVICE_USER}} -- /home/{{SERVICE_USER}}/seed/bin/apply-heartbeat-scratch.sh
sudo -H -u {{SERVICE_USER}} bash <<'EOF'
runtime_prompt='Run this read-only command with exec: PROJECT_SHELL=/opt/{{SERVICE_USER}}/libexec/project-shell DEFAULT_NODE=<default-node-version> PINNED_NODE=<project-node-version> ALIGNFIRST_CODE_AGENT=<claude|codex> /opt/{{SERVICE_USER}}/libexec/check-project-runtimes.sh. Reply exactly RUNTIME_OK when it passes. Otherwise reply RUNTIME_CHECK_FAILED and include the failure output.'
/opt/{{SERVICE_USER}}/bin/openclaw agent --agent main \
  --session-id "$(cat /proc/sys/kernel/random/uuid)" \
  --message "$runtime_prompt" --json
EOF
```

Config-schema warnings here mean a migration that the seed has not ported yet: back to the re-seed step. A repair doctor still proposes after the gateway ran (an orphaned session binding, for instance) needs one more migration window. The job list must show `heartbeat:main` as the only enabled system-owned job; another one is a default the release turned on, to opt out of in `seed/common.sh` ([gotchas.md](../gotchas.md#openclaw-schedules-background-model-runs-on-its-own)). `apply-heartbeat-scratch.sh` reports the scratch unchanged, or pushes `infra/openclaw/heartbeat-scratch.md` back when the release or the agent rewrote it ([04 § 7](../installations/04-openclaw.md#heartbeat-scratch)). The private gateway turn must return `RUNTIME_OK`; a direct harness pass does not cover OpenClaw's exported shell snapshot.

Once the release has run for a while, `openclaw update cleanup --dry-run` (gateway stopped) previews the retirement of the archived pre-migration files; run it without `--dry-run` to reclaim the space.
