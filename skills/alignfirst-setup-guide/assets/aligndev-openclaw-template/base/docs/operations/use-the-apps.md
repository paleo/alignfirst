---
title: Use the Apps
read_when:
  - letting someone reach the assistant from the desktop apps, or later from the mobile apps
  - a device pairing request is pending
  - a conversation does not reach a project
---

# Use the Apps

**Operator**, after the smoke test of [07-channel.md](../installations/07-channel.md). The OpenClaw apps are clients of the gateway that serves the channel: the web Control UI, the desktop apps and the mobile apps. A conversation created in an app is a working session, as a thread is on the channel.

The desktop apps come first, through the SSH tunnel. The mobile apps come later, once app conversations prove useful: they need Tailscale Serve.

The steps below derive from the installed OpenClaw documentation, under `/home/{{SERVICE_USER}}/.npm-system-global/lib/node_modules/openclaw/docs/`. Re-read the named documents after an OpenClaw upgrade.

## 1. Desktop apps

A desktop app reaches the loopback gateway through the SSH tunnel of [04 § 11](../installations/04-openclaw.md#11-dashboard), as the dashboard does (`gateway/remote.md`). Nothing new opens on the server. The tunnel logs in as `{{SERVER_ADMIN_USER}}`, so this route serves the people who hold that login.

> **User action required.** Keep the tunnel running while the app is in use:
>
> ```sh
> ssh -N -L 18789:127.0.0.1:18789 {{SERVER_ADMIN_USER}}@<vps-ip>
> ```

Each app connects to `ws://127.0.0.1:18789` with the gateway token (`platforms/*.md` lists the downloads):

- **macOS**: `OpenClaw-<version>.dmg` from the OpenClaw GitHub releases. **Connection…** → **OpenClaw runs** → **Remote (another host)**, then the address and the token (`platforms/mac/remote.md`). The app's own **SSH tunnel** mode runs `openclaw` commands on the server and needs the CLI on the SSH account's `PATH`; the manual tunnel needs nothing there.
- **Linux**: the desktop companion. **Gateways** → **Manage Gateways…** → **Add Gateway**, with a direct URL and token authentication (`platforms/linux.md`).
- **Windows**: Windows Hub. **Advanced setup**, a remote gateway by URL and token (`platforms/windows.md`).

The app loads the dashboard from `http://127.0.0.1:18789`, which the seed already lists in `gateway.controlUi.allowedOrigins`.

The gateway sees a tunnelled connection as loopback, and approves its first pairing without a prompt (`gateway/pairing.md`). The approved device holds operator access to the gateway, `operator.admin` included: creating a conversation on a project folder requires it. Check the new device after the first connection:

```sh
sudo -i -u {{SERVICE_USER}} -- openclaw devices list
```

The same silent approval covers the app's node, which offers the computer's screen and commands to the gateway. The assistant uses no node. An approved node would let a request from any team member act on that computer, so remove it. A removed node is never approved silently again; reject its later requests ([§ 3](#3-nodes-and-departures)).

```sh
sudo -i -u {{SERVICE_USER}} -- openclaw nodes list
sudo -i -u {{SERVICE_USER}} -- openclaw nodes remove --node <id>
```

## 2. Mobile apps, through Tailscale Serve

Opt-in, for later. The mobile apps need a `wss://` route: they refuse plain `ws://` beyond a private LAN. Tailscale Serve provides one (`gateway/stable-https-url.md`, `gateway/tailscale.md`). Tailscale terminates HTTPS on the tailnet and proxies to the loopback gateway, which opens no port of its own. Serve also opens the web Control UI and the desktop apps to members without the `{{SERVER_ADMIN_USER}}` login.

> **User action required.** In the Tailscale admin console, enable MagicDNS and **DNS > HTTPS Certificates**. Each team member's device joins the tailnet.

Install Tailscale on the server:

```sh
curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg \
  | sudo tee /usr/share/keyrings/tailscale-archive-keyring.gpg >/dev/null
curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.tailscale-keyring.list \
  | sudo tee /etc/apt/sources.list.d/tailscale.list
sudo apt update && sudo apt install -y tailscale
```

> **User action required.** Run `sudo tailscale up`, open the URL it prints and add the server to the tailnet.

The gateway runs Serve as `{{SERVICE_USER}}`, which has no sudo. Make that account the Tailscale operator:

```sh
sudo tailscale set --operator={{SERVICE_USER}}
```

Operator access covers this node's whole Tailscale state, and the assistant's `exec` runs as that account. It can serve any loopback port to the tailnet, such as a project's dev server, past the server's default-deny firewall. It can also take the node off the tailnet with `tailscale down`, and change its Funnel routes, which are public. The opt-in accepts this exposure. Keep Funnel off for the server: the tailnet policy grants it no `funnel` node attribute.

When the policy restricts access, allow the team's devices to reach the server on TCP 443; `gateway/stable-https-url.md` § 2 gives the grant and ACL forms.

Set `GATEWAY_TAILSCALE_SERVE=on` in the checkout's `infra/openclaw/.env`, then re-seed through [configure-assistant.md](configure-assistant.md). The seed sets `gateway.tailscale.mode serve` and `gateway.auth.allowTailscale false`, so a tailnet identity alone grants no access. The Serve origin is a `.ts.net` host, which the Control UI accepts as a private same-origin load without a `gateway.controlUi.allowedOrigins` entry.

Verify on the server that Serve is active and that the gateway still listens on loopback only:

```sh
sudo tailscale serve status
# Expected: https://<host>.<tailnet>.ts.net proxying to a loopback port
sudo ss -ltnp | grep ':18789'
# Expected: 127.0.0.1:18789 only
```

From a team device on the tailnet:

```sh
curl -sS -o /dev/null -w '%{http_code}\n' https://<host>.<tailnet>.ts.net/
# Expected: 200
```

The team uses `https://<host>.<tailnet>.ts.net` in a browser and `wss://<host>.<tailnet>.ts.net` where an app asks for a gateway URL.

### Devices

Each device needs the operator's approval. Approve only team members' devices. How a device pairs depends on the client (`web/control-ui/connect-and-pair.md`, `cli/qr.md`, `cli/dashboard.md`):

- **Mobile apps and Windows Hub** redeem a setup code. Generate one per device and hand it to the member through a private channel. The code is short-lived and carries the approval, so treat it like a password. Control UI → **Devices** → **Pair device** creates the same code from an approved browser.

  ```sh
  sudo -i -u {{SERVICE_USER}} -- openclaw qr
  ```

- **A browser** redeems a one-time link. `sudo -i -u {{SERVICE_USER}} -- openclaw dashboard --json` prints it as `browserUrl`, on the loopback address. Replace its base address with the `https://` Serve URL and its `gatewayUrl` fragment value with the `wss://` Serve URL, keep the other fragment values, and hand it to the member. It works once, within ten minutes. Use a persistent browser profile: a private window discards the device identity.
- **The macOS and Linux desktop apps** sign in with the gateway token, then wait for approval. The token alone grants full operator access through the gateway's HTTP API (`gateway/tools-invoke-http-api.md`): share it only through the password manager.

A device that signed in with the token appears as a pending request. Approve it after checking whose device it is:

```sh
sudo -i -u {{SERVICE_USER}} -- openclaw devices list
sudo -i -u {{SERVICE_USER}} -- openclaw devices approve <request-id>
```

On iOS and Android, install the OpenClaw app from the App Store or Google Play, then open **Settings** → **Gateway** and scan the setup code (`platforms/ios.md`, `platforms/android.md`).

## 3. Nodes and departures

A mobile app or a desktop app offers its device as a node: camera, location, screen and commands (`gateway/pairing.md`). Reject every node request:

```sh
sudo -i -u {{SERVICE_USER}} -- openclaw nodes pending
sudo -i -u {{SERVICE_USER}} -- openclaw nodes reject <request-id>
```

When a member leaves, remove their devices with `openclaw devices remove <device-id>`. When they held the gateway token, rotate it ([04 § Rotating a secret](../installations/04-openclaw.md#rotating-a-secret)).

## 4. Conversations

**Home**, the app's rolling main conversation, is for chat. When a message there calls for project work, the assistant asks for a new conversation.

Each work item gets its own conversation, from **New session**. Its **Project** decides where the conversation starts:

- **Empty**: the agent workspace. The assistant resolves the project from the request against the project inventory.
- **A project folder** under `/home/{{SERVICE_USER}}/projects/`, **Local**: the project's main checkout. The assistant opens or creates the ticket's workspace.
- **A project folder** with **Worktree**: OpenClaw creates a checkout on a branch `openclaw/<name>`. The assistant switches it to the ticket branch and registers it with the project's workspace tooling, then works there.

The coding agent's reports return to the conversation that delegated the work. Archiving a finished conversation is the member's call. OpenClaw then removes its worktree when the checkout is still on `openclaw/<name>`. A worktree switched to a ticket branch stays until the project's workspace teardown removes it (`concepts/managed-worktrees.md`).
