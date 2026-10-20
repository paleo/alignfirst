---
title: Update the Assistant
read_when:
  - upgrading OpenClaw, the coding agent, alignfirst, aligndev, ctx7 or the skills
  - replacing alcode and alproject with aligndev
---

# Update the Assistant

**Operator.** Every step is idempotent; re-apply all of them. Each maintenance window contains the assistant before an unlock and leaves the gateway stopped. Configuration changes are a different runbook: [configure-assistant.md](configure-assistant.md).

Open a report in `.reports/` and record the versions the verify step prints.

## Maintenance controls

Pull the repository and reinstall its root-owned controls before opening any maintenance window:

```sh
cd ~/{{ADMIN_REPOSITORY_NAME}} && git pull
sudo install -m 755 -o root -g root infra/openclaw/bin/assistant-kill.sh \
  /usr/local/sbin/alignfirst-assistant-kill
sudo install -m 755 -o root -g root infra/openclaw/bin/assistant-maintenance.sh \
  /usr/local/sbin/alignfirst-assistant-maintenance
sudo install -d -m 755 -o root -g root /opt/{{SERVICE_USER}}/libexec
sudo install -m 644 -o root -g root \
  infra/openclaw/deployment-profiles.mjs infra/openclaw/deployment-policy.mjs \
  /opt/{{SERVICE_USER}}/libexec/
sudo install -m 755 -o root -g root infra/openclaw/bin/bootstrap-backup.sh \
  /opt/{{SERVICE_USER}}/libexec/bootstrap-backup.sh
sudo /usr/local/sbin/alignfirst-assistant-kill
```

No root operation should execute a helper from a service-writable snapshot. Keep the account contained through backup, conversion and the remaining maintenance steps.

## Bootstrap backup before conversion

Run this schema-independent backup before refreshing `~/seed`, replacing deployed settings or invoking any profile-dependent backup, inventory, seed or maintenance window. It uses only shell utilities and tar, so the original direct `code.agent` settings remain untouched. Containment closes OpenClaw and thread-handoff writers before the copy:

```sh
sudo -H -u {{SERVICE_USER}} -- /opt/{{SERVICE_USER}}/libexec/bootstrap-backup.sh
```

Record the printed `~/backups/bootstrap/<stamp>/` path in the report, without its contents. Proceed only when the command succeeds and that directory contains `COMPLETE` and `service-home.tar.gz`. A failed attempt retains an incomplete directory; it is not a recovery point. Correct the failure and rerun before changing deployed state.

The private archive preserves the entire service home except `~/backups/`, including the original deployed settings, old seed and `.env`, native credentials, trust, sessions, shared skills, companions and registry, project files, npm/fnm trees, and all OpenClaw and thread-handoff database sidecars. Original modes and symlinks are retained inside the archive; the archive and marker are `0600`, and backup directories are `0700`. Check free space for the complete home. Symlink targets outside the home, external mounts and system-owned files outside the home need a separate reviewed private backup before proceeding. Links are never followed. Transient sockets are not persistent state.

This is a pre-conversion recovery snapshot, distinct from the mapped profile backup in [recover-assistant.md](recover-assistant.md#restore). To inspect or recover it, extract as the service account into a fresh private staging directory while contained. Review original destinations and symlinks before activating individual files. Keep legacy settings as evidence or for a reviewed rollback with the matching old packages and controls. New readers ignore retired launch fields with warnings; profile-only deployment helpers still require an explicit provisioned profile. Do not overlay the archive onto a live home or use it as a `native-recovery` mapping.

Now refresh the contained snapshot:

```sh
sudo rsync -a --delete infra/openclaw/ /home/{{SERVICE_USER}}/seed/
sudo chown -R {{SERVICE_USER}}:{{SERVICE_USER}} /home/{{SERVICE_USER}}/seed
```

## One-time: convert direct launch settings

Before installing profile-aware AlignDev or opening its first maintenance window, manually convert the admin repository's settings to this overlay's named-profile shape. Keep the existing agent, permission bypass and API-key removals. Set `code.profile` to the profile name and its explicit `configDir` to the existing service-account store (`~/.claude` or `~/.codex` on a default installation); remove Codex's former `CODEX_HOME` unset entry because the explicit directory now overrides it. Preserve native authentication and model defaults. Obtain approval for the reviewed settings replacement; no command below converts settings automatically. Unknown or obsolete keys warn on stderr and are ignored, including direct launch fields and `code.defaultProfiles`; they supply no legacy behavior. Manually move needed default-map preferences to matching profiles' `default: true`, omitting singleton flags and keeping profile names. Recognized invalid values, duplicate defaults and deployment safety violations still fail.

Bring `deployment-profiles.mjs`, `deployment-policy.mjs`, `seed.sh`, `seed/coding-agent.sh` and `assistant-maintenance.sh` forward together. After the bootstrap backup and snapshot refresh above, convert the installed settings while contained. The wrapper validates deployed profiles too:

```sh
sudo /usr/local/sbin/alignfirst-assistant-kill
sudo chattr -i /home/{{SERVICE_USER}}/.alignfirst \
  /home/{{SERVICE_USER}}/.alignfirst/aligndev.settings.json
sudo install -o root -g root -m 644 infra/openclaw/aligndev.settings.json \
  /home/{{SERVICE_USER}}/.alignfirst/aligndev.settings.json
sudo chattr +i /home/{{SERVICE_USER}}/.alignfirst/aligndev.settings.json \
  /home/{{SERVICE_USER}}/.alignfirst
```

Complete the package upgrade before CLI help, delegation or restart. After upgrading, re-seed through `config instructions agent-skills agent-config`, then reapply [06](../installations/06-security-hardening.md). The inventory covers every provisioned coding/quota store, including isolated custom paths beneath the service home. No account files or historical transcripts are migrated.

Existing managed native symlinks need an operator-reviewed conversion before the new wrapper can inventory them. For a former Claude skill alias, contain the account, unlock only its native skills root, verify the entry is a symlink to the intended canonical skill, remove that link (not its target), and copy the reviewed canonical directory into its place. Preserve executable bits with `rsync -a`. Check every profile's store, then apply the shared hardening policy. Do not disable symlink validation or recursively follow an alias during ownership changes.

## Back up

With reviewed profile settings installed and legacy managed links converted, run the strict mapped backup before the package upgrade. The original pre-conversion state remains in the bootstrap snapshot. Refresh the protected helpers and seed first as above; an old `backup.sh` may omit native stores, credentials, trust or package mode mappings ([recover-assistant.md](recover-assistant.md#restore)):

```sh
sudo /usr/local/sbin/alignfirst-assistant-kill
sudo -i -u {{SERVICE_USER}} -- /home/{{SERVICE_USER}}/seed/bin/backup.sh
```

## Project runtimes and launchers

Contain the account before replacing runtime files. The gateway stays stopped through the remaining steps:

```sh
sudo /usr/local/sbin/alignfirst-assistant-kill
```

For the first upgrade from a shared system/project runtime, provision system Node using [01-server-setup.md](../installations/01-server-setup.md), then run the fnm installation and version-provisioning blocks in [03 § 2](../installations/03-toolchain.md#2-project-runtimes). Use Node 24.16.0 or newer as the fnm default for the assistant's CLIs. Complete provisioning before adding the profile hooks below; an unavailable default prevents login-shell startup. Existing hosts keep their installed project versions.

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
sudo install -m 755 -o root -g root \
  infra/openclaw/node-runtime/pi-launcher.mjs \
  infra/openclaw/node-runtime/install-pi-launcher.sh \
  /opt/{{SERVICE_USER}}/libexec/
```

For an installed Pi child, regenerate `/opt/{{SERVICE_USER}}/bin/pi` using its exact reviewed version after the package maintenance window has restored root ownership, write restrictions and the immutable prefix anchor. The installer verifies the package's declared `bin.pi` and system Node. Never regenerate while the prefix is service-writable.

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

## One-time: replace alcode and alproject with aligndev

Run this section once, on a deployment that still has `@alignfirst/alcode` and `@alignfirst/alproject`. `aligndev` replaces both and prints the playbook through `aligndev guide`, so OpenClaw's managed playbook copy goes away.

1. Bring the admin repository to the current template: the variant's `infra/openclaw/aligndev.settings.json`, the `ALIGNFIRST_CODE_*` lines removed from `infra/openclaw/environment.d/coding-agent.conf` (delete the file when nothing else remains), the new maintenance wrapper, seed modules and workspace `AGENTS.md`. Then repeat [Maintenance controls](#maintenance-controls): the new wrapper reads the coding agent from `aligndev.settings.json`, and its `config` scope covers the aligndev settings.
2. Swap the packages:

   ```sh
   sudo /usr/local/sbin/alignfirst-assistant-maintenance packages -- bash -lc '
   set -e
   /opt/{{SERVICE_USER}}/libexec/admin-npm uninstall -g @alignfirst/alcode @alignfirst/alproject
   /opt/{{SERVICE_USER}}/libexec/admin-npm install -g alignfirst@latest aligndev@latest
   '
   ```

3. Rename the session directories from `_alcode` to `_aligndev`, so `aligndev code` finds the earlier sessions. A directory printed as `skipped` already has an `_aligndev` sibling: merge the two by hand. With a work-files repository, the next `alignfirst sync` publishes the rename.

   ```sh
   sudo -i -u {{SERVICE_USER}} -- bash -c '
   find ~/projects -name node_modules -prune -o -type d -name _alcode -prune -print |
     while read -r dir; do
       target="$(dirname "$dir")/_aligndev"
       if [ -e "$target" ]; then echo "skipped: $dir"; else mv -T "$dir" "$target"; fi
     done
   '
   ```

4. Remove the playbook copy:

   ```sh
   sudo /usr/local/sbin/alignfirst-assistant-maintenance skills -- \
     rm -rf /home/{{SERVICE_USER}}/.openclaw/skills/alignfirst-openclaw-playbook
   ```

5. Re-seed through [configure-assistant.md](configure-assistant.md). The seed installs the aligndev settings and the skill allowlist without the playbook. When step 1 deleted `coding-agent.conf`, also remove its installed copy: the seed only installs files, and that copy still carries the `ALIGNFIRST_CODE_*` lines. Then apply the new workspace `AGENTS.md` ([update-workspace.md](update-workspace.md)) and rebuild the user manager's environment:

   ```sh
   # only when step 1 deleted coding-agent.conf
   sudo -i -u {{SERVICE_USER}} -- rm -f /home/{{SERVICE_USER}}/.config/environment.d/coding-agent.conf
   sudo -i -u {{SERVICE_USER}} -- systemctl --user daemon-reexec
   ```

6. Verify the listing against the reviewed inventory: `openclaw`, the coding agent, `alignfirst`, `aligndev`, `ctx7`, plus any explicitly provisioned quota CLI.

   ```sh
   sudo -i -u {{SERVICE_USER}} -- /opt/{{SERVICE_USER}}/libexec/admin-npm ls -g --depth=0
   sudo -i -u {{SERVICE_USER}} -- bash -lc 'aligndev project doctor && aligndev guide >/dev/null && echo aligndev-ok'
   ```

Continue with the regular steps below.

## npm packages

The prefix is root-owned and immutable ([06](../installations/06-security-hardening.md)). The maintenance wrapper gives the service account this scope for the command, then restores root ownership, modes and the immutable flag through an `EXIT` trap. `openclaw update` is channel-aware and refreshes its plugins at the core's version; the other packages ride `@latest`.

```sh
sudo /usr/local/sbin/alignfirst-assistant-maintenance packages -- bash -lc '
openclaw update --yes --no-restart --accept-capabilities
openclaw plugins list --json | grep -q "\"alignfirst-service\"" &&
  openclaw plugins update @alignfirst/service-openclaw-plugin@latest --accept-capabilities
/opt/{{SERVICE_USER}}/libexec/admin-npm install -g alignfirst@latest aligndev@latest ctx7@latest
'
```

On the first profile-aware upgrade, re-seed now through the `config instructions` command in [configure-assistant.md](configure-assistant.md), before any CLI help, delegation or restart. This replaces the protected direct launch settings; the new CLI ignores them with warnings, so they no longer preserve the deployment's launch policy.

Immediately replace the projects marker, then validate with the new CLI. The wrapper refreshes the seed before each unlock and keeps the gateway stopped between these commands. The old marker's `portRange` key is rejected by the new CLI; individual project `.alignfirst.json` files retain their singular `portRange` claims:

```sh
sudo /usr/local/sbin/alignfirst-assistant-maintenance projects -- bash -lc '
set -e
install -m 644 ~/seed/projects/.alignfirst-projects.json ~/projects/.alignfirst-projects.json
aligndev project doctor
aligndev project list
'
```

If interrupted after the package upgrade, complete marker replacement and validation before any inventory command or restart.

`--accept-capabilities` accepts the plugins' reviewed capability changes. Without it the post-update plugin sync stops with an unresolved review, which `openclaw update repair --accept-capabilities` finishes.

`alignfirst-service` is an independent npm plugin, so its explicit update is separate from the core and
official channel-plugin update. The seed installs it the first time, in the re-seed step below, and
its state directory remains in place across package replacement. The explicit `@latest` replaces any older version pin in its tracked npm source.

Update the coding agent through its package-scoped command: [08-coding-agent.md § Update](../installations/08-coding-agent.md#update).

`openclaw update` exits 1 when its post-install doctor attempts a config write, which the immutable `openclaw.json` blocks (`ENOTDIR: not a directory, scandir '…/openclaw.json'`). Exit 0 means no write was attempted. Either way the package update succeeded; the verify step is what counts, and the migration step below finishes what the lock interrupted.

Verify the listing against the reviewed deployment inventory (`openclaw`, coding agents, `alignfirst`, `aligndev`, `ctx7`, and any explicit quota CLI). Remove unexplained packages through another `packages` maintenance window. After a Pi package update, regenerate its launcher first:

```sh
# Pi deployments only; match the exact version approved and installed through 08.
sudo /opt/{{SERVICE_USER}}/libexec/install-pi-launcher.sh <reviewed-version>
```

Then verify:

```sh
sudo -i -u {{SERVICE_USER}} -- bash -lc 'openclaw --version && alignfirst --version && aligndev --version && aligndev code --help >/dev/null && echo aligndev-ok && ctx7 --version'
sudo -i -u {{SERVICE_USER}} -- /opt/{{SERVICE_USER}}/libexec/admin-npm ls -g --depth=0
sudo -H -u {{SERVICE_USER}} bash -lc '
PROJECT_SHELL=/opt/{{SERVICE_USER}}/libexec/project-shell \
DEFAULT_NODE=<default-node-version> PINNED_NODE=<project-node-version> \
CODING_AGENT=<claude|codex|pi> \
  /opt/{{SERVICE_USER}}/libexec/check-project-runtimes.sh
'
```

Also run the [project-runtime audit](../installations/06-security-hardening.md#project-runtime-audit). It inventories writable runtime bins and globals across every installed version, separately from the protected package inventory.

## Skills

The shared `~/.agents` tree and OpenClaw's managed `~/.openclaw/skills` tree are protected. The `skills` scope also covers all inventoried native skill stores. Non-package skill symlinks are rejected: use canonical shared skills for Codex/Pi and real native copies for Claude, as described in `08`. Preserve executable modes when refreshing skill scripts.

```sh
sudo /usr/local/sbin/alignfirst-assistant-maintenance skills -- \
  bash -lc 'npx -y skills update -g -y </dev/null'
```

Repeat the idempotent shared-skill install block in [08-coding-agent.md](../installations/08-coding-agent.md) to ensure every target exists. For Claude, run its native-copy loop on every update, even when the targets already exist. Use the same `skills` scope, replacing the block's opening command with:

```sh
sudo /usr/local/sbin/alignfirst-assistant-maintenance skills -- bash <<'EOS'
```

The skills CLI may write escaped symlinks under `~/.openclaw/skills/` ([gotchas.md](../gotchas.md#skills-cli-writes-escaped-symlinks-under-openclawskills)). Policy restoration or the next window then fails closed. Keep the gateway stopped. The operator removes only direct symlink entries, without following their targets, after validating the root and its ancestors:

```sh
sudo /usr/local/sbin/alignfirst-assistant-kill
sudo /usr/bin/node --input-type=module -e '
  import { rejectSymlinks } from "/opt/{{SERVICE_USER}}/libexec/deployment-profiles.mjs";
  rejectSymlinks("/home/{{SERVICE_USER}}/.openclaw/skills");
'
sudo chattr -i /home/{{SERVICE_USER}}/.openclaw/skills
sudo find /home/{{SERVICE_USER}}/.openclaw/skills -maxdepth 1 -type l -print -delete
sudo chattr +i /home/{{SERVICE_USER}}/.openclaw/skills
sudo /usr/local/sbin/alignfirst-assistant-maintenance skills -- true
```

Run the cleanup after the CLI process tree is contained; delayed writes can outlive the CLI's return. A new maintenance window cannot clean those links itself because validation precedes unlock. Native-store symlinks need the separate reviewed conversion above. If cleanup retained a root-private inventory directory, restore those original resources too through [failed-cleanup recovery](recover-assistant.md#failed-maintenance-cleanup). Restart only after successful full policy restoration.

The setup guide and `sharp-writing` are shared through `~/.agents/skills/` ([gotchas.md](../gotchas.md#shared-skills-live-under-agentsskills)).

## Migrate after a core bump

A release can ship state migrations that only doctor's repair mode applies, with or without a TTY. `openclaw update repair` runs that repair, syncs the plugins at the core's version and refreshes the plugin registry; it needs the configuration and the workspace writable:

```sh
sudo /usr/local/sbin/alignfirst-assistant-maintenance config workspace -- \
  openclaw update repair --yes --accept-capabilities
```

Read its output: every imported or removed file is a change to port into the repository.

## Re-seed

Re-seed after a core bump, and whenever the `git pull` above changed anything under `infra/openclaw/`: the seed is the configuration's source of truth, and a release that adds a plugin or a tool ships as a seed change. Re-seed through [configure-assistant.md](configure-assistant.md).

A new OpenClaw release can retire keys the seed sets, change defaults and widen the channel plugin's declared capabilities. `config set` under the new binary rewrites the config in the current schema, and the surface module re-records the plugin consent. A `config set` that fails names a retired key: port its replacement into the seed modules before starting the gateway. The trailing interactive `openclaw doctor` shows the changed defaults; adopt them and record each one in [configuration.md](../configuration.md#stock-defaults).

## Gateway unit and restart

After an OpenClaw version bump, doctor may report a unit installed by an older version. Refresh the unit and drop-in, then restart the contained gateway. `gateway install --force` may start it early, so `start` would preserve the old process environment. The installer refuses group-writable paths ([gotchas.md](../gotchas.md#gateway-install-refuses-group-writable-systemd-paths)), hence the `chmod`:

```sh
sudo install -d -m 755 -o {{SERVICE_USER}} -g {{SERVICE_USER}} \
  /home/{{SERVICE_USER}}/.config/systemd/user/openclaw-gateway.service.d
sudo -H -u {{SERVICE_USER}} bash -lc 'chmod go-w ~/.config ~/.config/systemd ~/.config/systemd/user ~/.config/systemd/user/openclaw-gateway.service ~/.config/systemd/user/openclaw-gateway.service.d'
sudo /usr/local/sbin/alignfirst-assistant-maintenance config -- \
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

These are deployment-host acceptance procedures, separate from offline template checks. Record actual channel, native authentication/renewal, private backup/recovery and reboot results. For Pi, recheck the selected store, saved parent trust, native `bin` helpers, one copy of each subagent tool, and protected resources after updates. An OpenClaw Pi child does not require `pi-background`.

`--non-interactive` reports without applying anything:

```sh
sudo -i -u {{SERVICE_USER}} -- openclaw doctor --non-interactive
sudo -i -u {{SERVICE_USER}} -- openclaw cron list --all
sudo -i -u {{SERVICE_USER}} -- /home/{{SERVICE_USER}}/seed/bin/apply-heartbeat-scratch.sh
sudo -H -u {{SERVICE_USER}} bash <<'EOF'
runtime_prompt='Run this read-only command with exec: PROJECT_SHELL=/opt/{{SERVICE_USER}}/libexec/project-shell DEFAULT_NODE=<default-node-version> PINNED_NODE=<project-node-version> CODING_AGENT=<claude|codex|pi> /opt/{{SERVICE_USER}}/libexec/check-project-runtimes.sh. Reply exactly RUNTIME_OK when it passes. Otherwise reply RUNTIME_CHECK_FAILED and include the failure output.'
/opt/{{SERVICE_USER}}/bin/openclaw agent --agent main \
  --session-id "$(cat /proc/sys/kernel/random/uuid)" \
  --message "$runtime_prompt" --json
EOF
```

Config-schema warnings here mean a migration that the seed has not ported yet: back to the re-seed step. A repair doctor still proposes after the gateway ran (an orphaned session binding, for instance) needs one more migration window. The job list must show `heartbeat:main` as the only enabled system-owned job; another one is a default the release turned on, to opt out of in `seed/common.sh` ([gotchas.md](../gotchas.md#openclaw-schedules-background-model-runs-on-its-own)). `apply-heartbeat-scratch.sh` reports the scratch unchanged, or pushes `infra/openclaw/heartbeat-scratch.md` back when the release or the assistant rewrote it ([04 § 7](../installations/04-openclaw.md#heartbeat-scratch)). The private gateway turn must return `RUNTIME_OK`; a direct harness pass does not cover OpenClaw's exported shell snapshot.

Once the release has run for a while, `openclaw update cleanup --dry-run` (gateway stopped) previews the retirement of the archived pre-migration files; run it without `--dry-run` to reclaim the space.
