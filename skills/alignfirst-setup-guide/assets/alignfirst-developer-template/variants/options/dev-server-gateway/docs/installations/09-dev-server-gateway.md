---
title: Dev-Server Gateway
read_when:
  - installing or repairing the Caddy and Authelia gateway in front of the dev servers
  - adding a gateway user or a per-project subdomain
---

# Dev-Server Gateway

**Operator**, after [08-coding-agent.md](08-coding-agent.md), before [06-security-hardening.md](06-security-hardening.md). Dev servers (ports `{{PORT_RANGE_FIRST}}`–`{{PORT_RANGE_LAST}}`) are reachable only at `https://p<port>.{{DEV_DOMAIN}}`, or at `https://<prefix>-p<port>.{{DEV_DOMAIN}}` so a project can invent subdomains on its own port, behind one Authelia login. The portal is `https://auth.{{DEV_DOMAIN}}`; the session cookie sits on `{{DEV_DOMAIN}}`, so one login covers every dev server.

```text
Browser ──HTTPS/443──> Caddy ──forward_auth──> Authelia (127.0.0.1:9091)
                         │
                         └──reverse_proxy──> localhost:{{PORT_RANGE_FIRST}}..{{PORT_RANGE_LAST}}
```

Projects derive their URLs from `REMOTE_DEV_DOMAIN={{DEV_DOMAIN}}`, already in `environment.d/common.conf`, through `npm run workspace -- setup --profile remote` ([add-project.md](../operations/add-project.md)).

> **Note:** Commands shown are for Ubuntu 24.04. Adapt package, firewall, filesystem, and service-manager commands for another Linux server when needed.

## Prerequisites

> **User action required.**
>
> - DNS: a wildcard record `*.{{DEV_DOMAIN}}` → `<vps-ip>`. It covers `p<port>.`, `<prefix>-p<port>.` and `auth.` (single labels), so one record and one wildcard certificate serve them all.
> - A DNS API token with the scopes the `{{CADDY_DNS_MODULE}}` module documents; the DNS-01 wildcard challenge reads and writes records.
> - When the hosting provider runs a firewall in front of the server, open TCP 80 and 443 there too.

## Authelia

Install the latest release `.deb` (binary and a hardened unit running as `authelia`):

```sh
AUTHELIA_VERSION=$(curl -s https://api.github.com/repos/authelia/authelia/releases/latest | jq -r '.tag_name | ltrimstr("v")')
curl -fsSL -o /tmp/authelia.deb "https://github.com/authelia/authelia/releases/download/v${AUTHELIA_VERSION}/authelia_${AUTHELIA_VERSION}-1_$(dpkg --print-architecture).deb"
sudo apt install -y /tmp/authelia.deb && rm /tmp/authelia.deb
authelia --version
```

Install the repository's configuration and the state directory:

```sh
sudo install -m 640 -o root -g authelia ~/{{ADMIN_REPOSITORY_NAME}}/infra/gateway/authelia.yml /etc/authelia/configuration.yml
sudo install -d -o authelia -g authelia -m 750 /var/lib/authelia
```

> **User action required.** Replace the two `<secret>` values in `/etc/authelia/configuration.yml` (`session.secret`, `storage.encryption_key`) with `sudoedit`, each from `authelia crypto rand --length 64`, straight into the file — never into scrollback or the repository.

Decisions in that file: `CookieSession` as the only strategy, so application-level `Authorization` headers pass through untouched; the `OPTIONS` bypass covers CORS preflight (browsers send no cookies on preflight); no session provider, so sessions live in memory and users log in again after an Authelia restart; password reset disabled (users are operator-managed, no SMTP), and the filesystem notifier exists because Authelia requires one.

Users go in `/etc/authelia/users.yml` (root:authelia 640). The hash comes from `authelia crypto hash generate argon2`, which prompts for the password. The login is the username.

```sh
sudo install -m 640 -o root -g authelia /dev/null /etc/authelia/users.yml
sudo tee /etc/authelia/users.yml > /dev/null <<'USERS'
users:
  <username>:
    displayname: '<display-name>'
    password: '<argon2id-hash>'
    email: '<email>'
USERS
```

Adding a user later: generate a hash, append a block; `watch: true` reloads the file without a restart. The configuration file is not watched: after editing it, validate and restart (the restart empties the session store).

```sh
sudo authelia config validate --config /etc/authelia/configuration.yml
sudo systemctl enable --now authelia
curl -s http://127.0.0.1:9091/api/health   # {"status":"OK"}
```

## Caddy

Official apt repository, the DNS module, then hold the package so an apt upgrade cannot drop the module. Upgrades go through `caddy upgrade`, which preserves modules.

```sh
sudo curl -1fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
sudo tee /etc/apt/sources.list.d/caddy-stable.sources > /dev/null <<'EOT'
Types: deb
URIs: https://dl.cloudsmith.io/public/caddy/stable/deb/debian
Suites: any-version
Components: main
Signed-By: /usr/share/keyrings/caddy-stable-archive-keyring.gpg
EOT
sudo apt update
sudo apt install -y caddy
sudo caddy add-package {{CADDY_DNS_MODULE}}
sudo apt-mark hold caddy
caddy list-modules | grep dns.providers.{{CADDY_DNS_PROVIDER}}
```

The DNS credential lives in `/etc/caddy/gateway.env` (root-only, never committed), under the variable name the module documents, loaded through a systemd drop-in:

```sh
sudo install -m 600 -o root -g root /dev/null /etc/caddy/gateway.env
```

> **User action required.** Write `<DNS_CREDENTIAL_VARIABLE>=<token>` into `/etc/caddy/gateway.env` with `sudoedit`, and put the same variable name in the `acme_dns` line of `infra/gateway/Caddyfile` (commit that edit).

```sh
sudo mkdir -p /etc/systemd/system/caddy.service.d
sudo tee /etc/systemd/system/caddy.service.d/env.conf > /dev/null <<'EOT'
[Service]
EnvironmentFile=/etc/caddy/gateway.env
EOT
sudo systemctl daemon-reload
```

Install the Caddyfile. Its host regex is bounded to `{{PORT_RANGE_FIRST}}`–`{{PORT_RANGE_LAST}}`: every other localhost listener stays unreachable even for authenticated users. The optional `(?:[a-z0-9][a-z0-9-]*-)?` prefix is what makes `<prefix>-p<port>` work; it is non-capturing, so the port stays capture group 1. HTTP/3 is off (`protocols h1 h2`), so only TCP 443 is needed; port 80 serves the HTTP to HTTPS redirect.

```sh
sudo install -m 644 -o root -g root ~/{{ADMIN_REPOSITORY_NAME}}/infra/gateway/Caddyfile /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo systemctl restart caddy
journalctl -u caddy -f   # wait for "certificate obtained successfully" (DNS-01 takes a minute)
```

## Verify

> **User action required.** In a browser: `https://auth.{{DEV_DOMAIN}}` serves the portal with a valid certificate; `https://p<port>.{{DEV_DOMAIN}}` and `https://<prefix>-p<port>.{{DEV_DOMAIN}}` redirect to it when unauthenticated, and serve the dev server once logged in (a running dev server is needed: [add-project.md](../operations/add-project.md)).

The port range stays closed in UFW; only 22, 80 and 443 are open:

```sh
sudo ufw status numbered
```

Authelia's authz endpoint answers 200 for a bypassed request and 302 for a gated one:

```sh
probe() { curl -s -o /dev/null -w '%{http_code}\n' \
  -H "X-Forwarded-Method: $1" -H 'X-Forwarded-Proto: https' \
  -H "X-Forwarded-Host: $2" -H "X-Forwarded-Uri: $3" \
  http://127.0.0.1:9091/api/authz/forward-auth; }

probe OPTIONS p<port>.{{DEV_DOMAIN}} /   # 200
probe GET     p<port>.{{DEV_DOMAIN}} /   # 302
```

## Per-project subdomains

Nothing to register: `<prefix>-p<port>` is routed by the same regex, so a project owning one port serves as many hostnames as it likes on it. The prefix is lowercase letters, digits and dashes, starts with an alphanumeric, and the whole label stays within 63 characters. Caddy passes the original `Host` through, so which prefixes answer is the application's business. A bare `404` with an empty body comes from Caddy (port outside the range); anything with application headers comes from the dev server.
