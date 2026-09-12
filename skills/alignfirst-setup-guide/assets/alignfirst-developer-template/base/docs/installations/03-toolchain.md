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

## 2. Project runtimes

Install a pinned fnm release as a root-owned system tool:

```sh
runtime_tmp=$(mktemp -d)
curl -fsSL "https://github.com/Schniz/fnm/releases/download/v<fnm-version>/fnm-linux.zip" -o "$runtime_tmp/fnm.zip"
unzip "$runtime_tmp/fnm.zip" -d "$runtime_tmp"
sudo install -m 755 -o root -g root "$runtime_tmp/fnm" /usr/local/bin/fnm
rm -rf "$runtime_tmp"
```

Create fnm's state directory, install the latest patch of the current Node LTS as the default (at least 24.16.0 for the developer CLIs), then install every version declared by a managed project. Provision without loading profiles so an unavailable default cannot block this step:

```sh
sudo install -d -m 755 -o {{SERVICE_USER}} -g {{SERVICE_USER}} /home/{{SERVICE_USER}}/.local/share/fnm
sudo -H -u {{SERVICE_USER}} bash --noprofile --norc -c '
set -e
export FNM_DIR="$HOME/.local/share/fnm"
eval "$(/usr/local/bin/fnm env --shell bash)"
fnm install --lts
fnm default <default-node-version>
fnm install <project-node-version>
'
```

Repeat the last command for each distinct project version. Version provisioning is an operator action; a declared version that is absent stops shell startup.

Deploy the root-owned launchers and runtime initialization files from this checkout:

```sh
sudo install -d -m 755 -o root -g root /opt/{{SERVICE_USER}}/bin /opt/{{SERVICE_USER}}/libexec
sudo install -m 755 -o root -g root infra/openclaw/bin/openclaw /opt/{{SERVICE_USER}}/bin/openclaw
sudo install -m 755 -o root -g root \
  infra/openclaw/node-runtime/project-shell \
  infra/openclaw/node-runtime/admin-npm \
  infra/openclaw/node-runtime/check-project-runtimes.sh \
  /opt/{{SERVICE_USER}}/libexec/
sudo install -m 644 -o root -g root infra/openclaw/node-runtime/init.bash /opt/{{SERVICE_USER}}/libexec/init.bash
```

## 3. Login profile

`sudo -i` runs no `pam_systemd`, and systemd user services read neither `.bashrc` nor `.profile`. `~/.bash_profile` bridges the two worlds for login shells, then loads the shared runtime initialization. OpenClaw's `project-shell` reads `.bash_profile`; interactive non-login shells started by the coding agent read `.bashrc`.

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
. /opt/{{SERVICE_USER}}/libexec/init.bash
PROFILE
printf '\ncase $- in *i*) . /opt/{{SERVICE_USER}}/libexec/init.bash ;; esac\n' | \
  sudo -H -u {{SERVICE_USER}} tee -a /home/{{SERVICE_USER}}/.bashrc > /dev/null
```

The `environment.d` bridge stays before `init.bash`; the runtime initialization must be the profile's last line. A shell-local guard prevents the `.profile` and `.bash_profile` paths from initializing fnm twice. `project-shell` clears that guard and inherited fnm state before every OpenClaw exec login shell.

## 4. npm prefix and global CLIs

The protected CLIs live in `~/.npm-system-global/`, but no `.npmrc` selects that prefix. `admin-npm` fixes both the system interpreter and the destination. Versions are unpinned: the update runbook installs `@latest` and records the versions in its report.

```sh
sudo -i -u {{SERVICE_USER}} -- /opt/{{SERVICE_USER}}/libexec/admin-npm install -g \
  openclaw alignfirst @paleo/alcode @paleo/alproject ctx7
```

Install the selected coding agent under the same prefix: [08-coding-agent.md § Install](08-coding-agent.md#install). The seed in `04` requires it.

Verify:

```sh
sudo -i -u {{SERVICE_USER}} -- bash -lc 'which node npm openclaw alignfirst alcode alproject ctx7'
# Expected: node and npm under $FNM_MULTISHELL_PATH/bin; openclaw under /opt/{{SERVICE_USER}}/bin; the rest under /home/{{SERVICE_USER}}/.npm-system-global/bin
sudo -H -u {{SERVICE_USER}} bash -lc '
PROJECT_SHELL=/opt/{{SERVICE_USER}}/libexec/project-shell \
DEFAULT_NODE=<default-node-version> \
PINNED_NODE=<project-node-version> \
ALIGNFIRST_CODE_AGENT=<claude|codex> \
  /opt/{{SERVICE_USER}}/libexec/check-project-runtimes.sh
'
```

The harness covers independent and inherited gateway shells, repeated initialization, declaration edge cases, output on both streams, protected-command precedence and process ownership.

## 5. Other package managers

Install pnpm or yarn system-wide only when a managed project uses it. These packages live under `/usr/lib/node_modules/` and survive replacement of the `nodejs` package:

```sh
# Run only the lines needed by the managed projects.
sudo /usr/bin/npm install -g pnpm
sudo /usr/bin/npm install -g yarn
```

## 6. Git access

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

## 7. Rootless check

```sh
sudo -i -u {{SERVICE_USER}} -- podman info --format '{{.Host.Security.Rootless}}'
# Expected: true
```

`alproject` needs the projects marker installed in `04`. Continue with [05-openclaw-dependencies.md](05-openclaw-dependencies.md).
