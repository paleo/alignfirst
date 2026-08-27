---
title: Server Setup
read_when:
  - bootstrapping a fresh server for the AlignFirst Developer
  - replaying the OS-level baseline (accounts, SSH, firewall, Node, containers)
---

# Server Setup

**Human administrator**, on a fresh server, from the laptop. First runbook of the execution order: `01` → `02` → `03` → `05` → `07` (platform part) → `04` → `08` → `09` when selected → `06` → `07` (smoke test). The last step installs the coding agent for the admin account; from there, a session in the cloned repository takes over as the **operator**.

> **Note:** Commands shown are for Ubuntu 24.04. Adapt package, firewall, filesystem, and service-manager commands for another Linux server when needed.

Every command below runs as the cloud image's default user (`ubuntu`) until the admin account exists, then as `{{SERVER_ADMIN_USER}}`.

## 1. Admin account

```sh
sudo adduser --disabled-password --gecos "" {{SERVER_ADMIN_USER}}
sudo usermod -aG sudo {{SERVER_ADMIN_USER}}
```

Passwordless sudo (login is key-only):

```sh
sudo bash -c 'echo "{{SERVER_ADMIN_USER}} ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/{{SERVER_ADMIN_USER}} && chmod 440 /etc/sudoers.d/{{SERVER_ADMIN_USER}}'
```

Copy the SSH key from the default user:

```sh
sudo install -d -m 700 -o {{SERVER_ADMIN_USER}} -g {{SERVER_ADMIN_USER}} /home/{{SERVER_ADMIN_USER}}/.ssh
sudo install -m 600 -o {{SERVER_ADMIN_USER}} -g {{SERVER_ADMIN_USER}} /home/ubuntu/.ssh/authorized_keys /home/{{SERVER_ADMIN_USER}}/.ssh/authorized_keys
```

> **User action required.** From a second terminal, confirm `ssh {{SERVER_ADMIN_USER}}@<vps-ip>` works. Continue in that session as `{{SERVER_ADMIN_USER}}`.

Remove the default user:

```sh
sudo pkill -u ubuntu 2>/dev/null
sudo deluser --remove-home ubuntu
```

## 2. System update, hostname, time zone

```sh
sudo apt update && sudo apt upgrade -y
sudo apt install -y unzip jq
sudo hostnamectl set-hostname {{SERVER_HOST}}
sudo timedatectl set-timezone {{TIME_ZONE}}
```

## 3. SSH key-only

Cloud-init drops `/etc/ssh/sshd_config.d/50-cloud-init.conf` with `PasswordAuthentication yes`, and sshd reads the drop-ins before its main file with first-match-wins. A drop-in that sorts earlier overrides it:

```sh
sudo tee /etc/ssh/sshd_config.d/01-disable-password-auth.conf > /dev/null <<'CONF'
# Key-only SSH. Sorts before 50-cloud-init.conf (sshd: first match wins per directive).
PasswordAuthentication no
KbdInteractiveAuthentication no
CONF
sudo chmod 644 /etc/ssh/sshd_config.d/01-disable-password-auth.conf
```

Keepalive: the default (1 h) lets NAT and firewall idle drops freeze sessions long before sshd notices:

```sh
sudo tee /etc/ssh/sshd_config.d/02-keepalive.conf > /dev/null <<'CONF'
# 60 s pings so NAT/firewall idle drops do not freeze sessions.
ClientAliveInterval 60
ClientAliveCountMax 3
CONF
sudo chmod 644 /etc/ssh/sshd_config.d/02-keepalive.conf
```

> **User action required — before reloading sshd.** From the laptop, in a second terminal, confirm key authentication works on a fresh connection. A typo in the drop-in would otherwise surface after the reload, with no way back in:
>
> ```sh
> ssh {{SERVER_ADMIN_USER}}@<vps-ip> 'echo key-auth-ok'
> ```

Validate, then reload (keeps the active session):

```sh
sudo sshd -t
sudo systemctl reload ssh
sudo sshd -T | grep -iE "passwordauth|kbdinteractive"
# Expected: passwordauthentication no, kbdinteractiveauthentication no
```

> **User action required — after reload.** Confirm password authentication is refused:
>
> ```sh
> ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no {{SERVER_ADMIN_USER}}@<vps-ip>
> # Expected: Permission denied (publickey).
> ```

## 4. UFW base policy

Only SSH is open. The dev-server port range stays closed: managed projects are reached through the gateway of `09`, or locally through an SSH tunnel.

```sh
sudo apt install -y ufw
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow ssh
sudo ufw enable
sudo ufw status verbose
```

<!-- DEV_SERVER_GATEWAY_SECTION -->
Ports 80 and 443 are opened in [09-dev-server-gateway.md](09-dev-server-gateway.md), once Caddy is configured.
<!-- DEV_SERVER_GATEWAY_SECTION -->

## 5. Swap and inotify limits

6G is a sound `<swap-size>` for an 8–16 GB server:

```sh
sudo fallocate -l <swap-size> /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

The defaults exhaust quickly across the gateway, several Node watchers and coding-agent sessions:

```sh
sudo sysctl fs.inotify.max_user_watches=524288       # default 30238
sudo sysctl fs.inotify.max_user_instances=1024       # default 128
echo 'fs.inotify.max_user_watches=524288'   | sudo tee -a /etc/sysctl.conf
echo 'fs.inotify.max_user_instances=1024'   | sudo tee -a /etc/sysctl.conf
```

## 6. Node

One system Node, from NodeSource, backs the gateway, every CLI of the service account and the managed projects. `openclaw doctor` rejects version-manager Nodes as a gateway runtime, and a single `npm` on `PATH` is what keeps `openclaw update` safe (it installs into whichever prefix that `npm` owns). Pin an exact version and hold the package so `apt upgrade` leaves it alone:

```sh
curl -fsSL https://deb.nodesource.com/setup_<node-major>.x | sudo -E bash -
sudo apt install -y nodejs=<node-version>-1nodesource1
sudo apt-mark hold nodejs
/usr/bin/node --version
/usr/bin/npm --version
```

npm releases on its own schedule; bump the bundled one in place. Reinstalling the `nodejs` package resets it, so re-run this after the recipe below:

```sh
sudo /usr/bin/npm install -g npm@<npm-version>
/usr/bin/npm --version
```

To move to another pinned version later:

```sh
sudo apt-mark unhold nodejs
sudo apt install -y nodejs=<node-version>-1nodesource1
sudo apt-mark hold nodejs
```

## 7. Containers

Containers run rootless under Podman; there is no Docker daemon. Membership in the `docker` group amounts to root (the daemon API mounts any path as root), and root Docker's published ports bypass UFW (DNAT happens before the INPUT chain). Podman's rootless listener is filtered like any process, and a container escape yields the invoking account's rights.

Podman comes from the distro with `uidmap` (`newuidmap`/`newgidmap`). Ubuntu 24.04's `kernel.apparmor_restrict_unprivileged_userns=1` is satisfied by the packaged profile. Short image names need a search registry, which noble does not ship:

```sh
sudo apt install -y podman uidmap
ls /etc/apparmor.d/podman   # must exist
echo 'unqualified-search-registries = ["docker.io"]' | sudo tee -a /etc/containers/registries.conf
```

The genuine `docker` CLI and `docker compose` plugin stay installed as pure clients, pointed at podman's Docker-compatible socket through `DOCKER_HOST` (set in `04`), so project scripts that hard-code `docker …` run unchanged. Nobody joins a `docker` group.

```sh
sudo apt install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

sudo tee /etc/apt/sources.list.d/docker.sources <<EOT
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Signed-By: /etc/apt/keyrings/docker.asc
EOT

sudo apt update
sudo apt install -y docker-ce-cli docker-compose-plugin
```

## 8. Coding agent for the admin account

Install the selected coding agent for `{{SERVER_ADMIN_USER}}`: [08-coding-agent.md § Admin Account](08-coding-agent.md#admin-account).

Then hand over to a session of that agent in the admin account. It clones the repository and continues with [02-admin-repository.md](02-admin-repository.md) as the operator.
