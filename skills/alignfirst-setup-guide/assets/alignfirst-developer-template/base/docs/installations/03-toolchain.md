---
title: Toolchain of the Service Account
read_when:
  - creating the service account and installing its CLIs
  - giving the service account access to the git hosts
---

# Toolchain of the Service Account

**Operator**, after [02-admin-repository.md](02-admin-repository.md), before [05-openclaw-dependencies.md](05-openclaw-dependencies.md). Creates `{{SERVICE_USER}}`, then installs its CLIs and git access. Service-account commands are written as `sudo -i -u {{SERVICE_USER}} -- <command>`, to paste from the operator's shell.

> **Note:** Commands shown are for Ubuntu 24.04. Adapt package, firewall, filesystem, and service-manager commands for another Linux server when needed.

## 1. Service account

A fixed UID outside the human range (1000–1999) keeps the service identity distinct; 2000 is a sound `<service-uid>`. No sudo, no `docker` group, no inbound SSH: the operator reaches the account with `sudo -i -u {{SERVICE_USER}}`.

```sh
sudo addgroup --gid <service-uid> {{SERVICE_USER}}
sudo adduser --disabled-password --gecos "" --uid <service-uid> --gid <service-uid> {{SERVICE_USER}}
id {{SERVICE_USER}}
grep {{SERVICE_USER}} /etc/subuid /etc/subgid
# Expected: one {{SERVICE_USER}}:<start>:65536 line in each (rootless podman maps container IDs through them)
```

## 2. Login profile

`sudo -i` runs no `pam_systemd`, and systemd user services read neither `.bashrc` nor `.profile`. `~/.bash_profile` bridges the two worlds for login shells: `XDG_RUNTIME_DIR` so `systemctl --user` works, the `environment.d` variables the gateway also receives, and the npm prefix on `PATH`.

```sh
sudo -u {{SERVICE_USER}} tee /home/{{SERVICE_USER}}/.bash_profile > /dev/null <<'PROFILE'
[ -f "$HOME/.profile" ] && . "$HOME/.profile"
# systemctl --user needs XDG_RUNTIME_DIR; sudo -i opens no PAM session. Requires loginctl enable-linger (04).
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
# systemd --user injects ~/.config/environment.d/*.conf into user services; sudo -i shells miss them.
if [ -d "$HOME/.config/environment.d" ]; then
  set -a
  for f in "$HOME/.config/environment.d"/*.conf; do
    [ -r "$f" ] && . "$f"
  done
  set +a
fi
export PATH="$PATH:$HOME/.npm-system-global/bin"
PROFILE
```

## 3. npm prefix and global CLIs

The account has no sudo, so npm globals go to `~/.npm-system-global/`. Versions are unpinned: the update runbook installs `@latest` and records the versions in its report.

```sh
sudo -H -u {{SERVICE_USER}} bash -c 'printf "prefix=%s\n" "$HOME/.npm-system-global" > ~/.npmrc'
sudo -i -u {{SERVICE_USER}} -- /usr/bin/npm install -g openclaw @paleo/alcode @paleo/alproject ctx7
```

Install the selected coding agent under the same prefix: [08-coding-agent.md § Install](08-coding-agent.md#install). The seed in `04` requires it.

Verify:

```sh
sudo -i -u {{SERVICE_USER}} -- bash -lc 'which node npm openclaw alcode alproject ctx7'
# Expected: /usr/bin/node, /usr/bin/npm, then /home/{{SERVICE_USER}}/.npm-system-global/bin/… for the rest
```

## 4. Git access

Two supported paths for `{{GIT_HOSTS}}`; keep the one matching the deployment's access policy. The SSH key is registered here. The host CLI path (the CLI serves an OAuth token to git over HTTPS, so no key is registered) waits for `05`, which installs the CLIs and authenticates them for both paths.

**SSH key.** One key serves every host. `ssh-keyscan` is trust-on-first-use: compare the printed fingerprints with the host's published ones before trusting them.

```sh
sudo -H -u {{SERVICE_USER}} bash -lc 'mkdir -p ~/.ssh && chmod 700 ~/.ssh && ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -C "{{SERVICE_USER}}@{{SERVER_HOST}}" -N "" && ssh-keyscan -t ed25519 <git-host> >> ~/.ssh/known_hosts && ssh-keygen -lf ~/.ssh/known_hosts && cat ~/.ssh/id_ed25519.pub'
```

> **User action required.** Add the printed public key to the developer's own account on each git host, logged in as that account.

```sh
sudo -i -u {{SERVICE_USER}} -- ssh -T git@<git-host>
```

**Git identity**, for both paths:

```sh
sudo -i -u {{SERVICE_USER}} -- git config --global user.name "{{DEVELOPER_NAME}}"
sudo -i -u {{SERVICE_USER}} -- git config --global user.email "<email>"
sudo -i -u {{SERVICE_USER}} -- git config --global init.defaultBranch main
sudo -i -u {{SERVICE_USER}} -- git config --global fetch.prune true
sudo -i -u {{SERVICE_USER}} -- git config --global pull.rebase true
```

## 5. Rootless check

```sh
sudo -i -u {{SERVICE_USER}} -- podman info --format '{{.Host.Security.Rootless}}'
# Expected: true
```

`alproject` is configured in `04`; running it before that fails on the missing `~/.alproject.json`. Continue with [05-openclaw-dependencies.md](05-openclaw-dependencies.md).
