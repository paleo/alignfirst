---
title: Gotchas
read_when:
  - something on the server looks wrong and you are about to fix it
---

# Gotchas

Behaviors that look like bugs and are intentional, with the reason. Read the relevant section before changing anything.

## No version manager in the service account's PATH

OpenClaw is installed under one prefix (`~/.npm-system-global/`, fed by `/usr/bin/npm`). A version manager shifts the active prefix: `which openclaw` returns nothing, and `openclaw update` installs the new version into the manager's prefix while the gateway unit keeps running the old one. `openclaw doctor` also flags version-manager Nodes as fragile runtimes. `openclaw update` is the upgrade path because it refreshes the plugins in lockstep with the core; it stays safe only with exactly one `npm` on `PATH`. A pinned `npm install -g openclaw@<version>` skips that lockstep: an external plugin built for the previous core fails to load on the new one, and each needs `openclaw plugins install npm:@openclaw/<name>@<version> --accept-capabilities`. A project that needs another Node runs it in a container.

## Containers are per-user

Rootless podman scopes containers to the invoking user's socket. `docker ps` as the operator shows nothing (or the operator's own containers), never the developer's:

```sh
sudo -i -u {{SERVICE_USER}} -- docker ps
```

A bare `docker …` without `DOCKER_HOST` fails on `unix:///var/run/docker.sock`: the variable is missing, no daemon is down.

## `skills` CLI writes escaped symlinks under `~/.openclaw/skills/`

For every skill it updates, `npx skills update` drops a symlink at `~/.openclaw/skills/<name>` pointing outside that directory, to the canonical `~/.agents/skills/<name>`. OpenClaw's path-safety check rejects it and `openclaw doctor` logs `Skipping escaped skill path …`. Discovery works through the `~/.agents/skills/` tier anyway. [update-developer.md](operations/update-developer.md) sweeps the links after each update.

## `~/.agents/skills` is shared between OpenClaw and the coding agent

Skills install once, into `~/.agents/skills/`, which OpenClaw and the delegated coding agent
both scan. OpenClaw loads only its `agents.defaults.skills` allowlist, including
`alignfirst-setup-guide` for project creation; the coding agent loads every skill there. The `al*`
command skills (`al`, `alplan`, `alspec`, `aldescription`, `alreview`, `alcatchup`, `almerge`) sit
outside OpenClaw's allowlist and look like orphans in its inventory. They are active skills of the
coding agent: `skills remove` would delete the canonical copy for both.

## Moving a project breaks its workspace registry

`@paleo/workspace` stores each worktree as an absolute path in `.local-wt/workspace-registry/workspaces.json`. After a `mv`, every command fails with `The workspace name "<name>" is already taken by <old-path>`, and no command repairs it: `prune` skips main worktrees, `remove` is destructive. Rewrite the `worktree` string in place, keeping the name key, `createdAt`, `status` and `portIndex` (`portIndex` pins the linked worktrees' ports). `git worktree repair` is still needed for linked worktrees. `alproject` reads the repaired git worktrees directly.

## Heartbeat cost is a main-session problem

A bill that climbs day after day with near-zero output (the agent waking, finding nothing) is the heartbeat re-sending an ever-growing main-session transcript; `session.threadBindings` and `resetByType.thread` govern threads only. The slope scales with the tick frequency: it appeared under 30-minute ticks. The seed sets `every: "24h"` and keeps the heartbeat on, because the `alcode` completion wake is a heartbeat-sourced turn; `isolatedSession` and `lightContext` would each break that wake. A comment-only scratch on the `heartbeat:main` job skips the model call on periodic ticks entirely. When the cost appears despite it, run `apply-heartbeat-scratch.sh` ([04 § 7](installations/04-openclaw.md#heartbeat-scratch)): it restores the snapshot when the agent has rewritten the scratch ([06](installations/06-security-hardening.md#configuration-and-workspace-files)).

## OpenClaw schedules background model runs on its own

Three defaults spend tokens without a user message: the memory-core *dreaming* sweep (a daily 03:00 isolated turn that rewrites `MEMORY.md`), the weekly *skill collection review* (`skills.workshop.autonomous.mode` defaults to `auto`, which also lets the agent rewrite writable skills), and the pre-compaction *memory flush* (an agentic turn that writes `memory/YYYY-MM-DD.md` when a long session nears its token limit). The seed turns each off: `plugins.slots.memory none`, `skills.workshop.autonomous.mode off`, `agents.defaults.compaction.memoryFlush.enabled false`. After an upgrade, `openclaw cron list --all` must list `heartbeat:main` as the only enabled system-owned job ([update-developer.md](operations/update-developer.md#smoke-test)); a new one is a default the release turned on, to opt out of in `seed/common.sh`. A dated note under `workspace/memory/` means the flush is back on.

## `plugins.allow` does not govern slot plugins

`memory-core` is the default owner of the `memory` slot and loads whatever `plugins.allow` says; `plugins.slots.memory` is the switch. A leftover `plugins.entries.memory-core` block then warns *plugin disabled but config is present* and makes doctor propose an auto-enable: unset the block, do not tune it.

## `gateway install` refuses group-writable systemd paths

The installer inspects `~/.config`, `~/.config/systemd`, `~/.config/systemd/user`, the unit file, its `.bak` and its `.d/` directory, and aborts with `[unsafe-permissions]` when any is `g+w`, which the account's default umask (`0002`) produces. Run `chmod go-w` on the paths it names, without `-R`; it names one path per run.

## `sudo -i -u … bash -lc '…'` expands the string twice

`sudo -i` runs the service account's login shell with the rest as its command, so a nested `bash -lc '…'` loses its single quotes to that outer shell and every `$var` is expanded one layer too early: variables the inner script defines come out empty. Worse, `.bash_profile` sources `environment.d/*.conf` in a `set -a` loop that leaves its loop variable `f` exported, so a nested `for f in …` inherits a live stale value.

```sh
sudo -i -u {{SERVICE_USER}} -- bash -lc 'z=hello; printf "[%s]" "$z"'   # prints []
sudo -H -u {{SERVICE_USER}} bash -lc 'z=hello; printf "[%s]" "$z"'      # prints [hello]
```

The re-escaping also mangles a `\`+newline inside the quoted script: it comes out as an escaped space, so the next `~/path` becomes `~/ path` and the files land in a directory named `~/ `. Keep a `bash -lc` script on one line, or feed a multi-line script on stdin: `sudo -H -u {{SERVICE_USER}} bash <<'EOF' … EOF`.

`sudo -i -u {{SERVICE_USER}} -- <command>` is fine for a one-line command that defines no variable. Anything with an assignment or a loop uses `sudo -H -u {{SERVICE_USER}} bash -lc '…'`.

## apt without a TTY dies in a debconf dialog

While a kernel upgrade is pending, package postinsts raise a "Newer kernel available" notice. Over SSH without a TTY, whiptail cannot draw it and apt exits on `Failed to open terminal`. The packages are usually installed by then (`dpkg -l | awk '$1 !~ /^ii$/'`, `apt-get check`). Prefix installs with `DEBIAN_FRONTEND=noninteractive` to skip the dialog.

## Config-writing commands fail while `openclaw.json` is immutable

Every `openclaw` command that rewrites the config (`config set`, `plugins install`/`uninstall`, the seed, `openclaw update`'s post-install doctor) fails while the `chattr +i` flag is on, and not always legibly: `ENOTDIR: not a directory, scandir '~/.openclaw/openclaw.json'` is one shape. Run it through the `config` scope of the root-owned maintenance wrapper: [configure-developer.md](operations/configure-developer.md).

## `MEDIA:` and `message` attachments read different media roots

Two outbound paths deliver a local file with different read policies. The `MEDIA:` directive adds the parent directory of each emitted file to the allowed roots, so it delivers from anywhere. The `message` tool's structured attachment reads the static roots only: the workspace plus `~/.openclaw/{media,state/*}`. A file outside them is rejected. This is why the drop zone is `~/.openclaw/workspace/scratch/`, inside the workspace: both paths read it. Move the file there instead of switching delivery paths.

## A new `environment.d` variable needs `daemon-reexec`

`systemd --user` computes its environment block once. A gateway restart alone keeps the old block; run `systemctl --user daemon-reexec` first, then restart ([04 § 9](installations/04-openclaw.md#9-environment-changes)). Only matters on a live machine: at boot, lingering builds the block fresh.

## Prefer interactive `openclaw doctor` over `--fix`

`--fix` applies every recommendation without review. Plain `openclaw doctor` prompts before each change, so a recommendation that contradicts the seed can be declined; without a TTY it only reports. Two exceptions use `--fix`: the first install ([04 § 3](installations/04-openclaw.md#3-seed)), to create the credential scaffolding, and the migration after a core bump ([update-developer.md](operations/update-developer.md#migrate-after-a-core-bump)), because a release's state migrations apply in repair mode only, TTY or not.

<!-- DEV_SERVER_GATEWAY_SECTION -->
## Gateway URLs answer curl with a redirect

An unauthenticated request to `https://p<port>.{{DEV_DOMAIN}}` returns a 302 to the Authelia portal, whatever the client: curl, webhooks and cross-site fetches get the redirect instead of data. This is the gateway working as designed (cookie-only authentication, [09](installations/09-dev-server-gateway.md)). Machine access would need a dedicated Authelia endpoint, deliberately not configured. The `OPTIONS` bypass covers CORS preflight only.
<!-- DEV_SERVER_GATEWAY_SECTION -->
