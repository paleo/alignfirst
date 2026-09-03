---
title: Slack Channel
read_when:
  - creating the Slack app that feeds the SLACK_* variables of .env
  - rotating a Slack token or moving the bot to another channel
  - running the channel smoke test after the developer is installed
---

# Slack Channel

**Role: Slack administrator** for the platform setup, **operator** for the smoke test. Platform setup runs before `04` (its tokens and IDs go into `infra/openclaw/.env`); the smoke test runs after `08`.

## Socket Mode

OpenClaw talks to Slack in Socket Mode: the gateway opens an outbound WebSocket, so the server needs no public URL, no webhook, and no inbound firewall rule. Two tokens are involved: a **bot token** (`xoxb-…`) that reads and posts messages, and an **app-level token** (`xapp-…`) that only opens the WebSocket.

## Create the App from JSON

The JSON configuration below keeps what a member of one **private** channel needs: read history and files, post and edit its own messages, read and add reactions, manage pins, see users, and run the `/openclaw` slash command. It omits the DM, group-DM, and Home-tab surfaces, so Slack cannot deliver a DM to the bot even if the gateway's `dmPolicy` drifts. It omits `channels:manage`, so the bot cannot invite, rename, or archive the channel.

> **User action required.** Go to <https://api.slack.com/apps/new>, choose the JSON configuration path, pick the workspace, paste the JSON, then select **Create**. Leave **Distribution** off.

```json
{
  "display_information": {
    "name": "{{DEVELOPER_NAME}}",
    "description": "AlignFirst Developer"
  },
  "features": {
    "bot_user": { "display_name": "{{DEVELOPER_NAME}}", "always_online": true },
    "app_home": {
      "home_tab_enabled": false,
      "messages_tab_enabled": false,
      "messages_tab_read_only_enabled": false
    },
    "slash_commands": [
      {
        "command": "/openclaw",
        "description": "Send a command to the developer",
        "should_escape": false
      }
    ]
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "app_mentions:read",
        "chat:write",
        "commands",
        "files:read",
        "files:write",
        "groups:history",
        "groups:read",
        "pins:read",
        "pins:write",
        "reactions:read",
        "reactions:write",
        "users:read"
      ]
    }
  },
  "settings": {
    "socket_mode_enabled": true,
    "event_subscriptions": {
      "bot_events": [
        "app_mention",
        "message.groups",
        "member_joined_channel",
        "member_left_channel",
        "pin_added",
        "pin_removed",
        "reaction_added",
        "reaction_removed"
      ]
    }
  }
}
```

The seed enables the slash command on the gateway side (`channels.slack.slashCommand`), so OpenClaw chat commands run as `/openclaw /reset`. The command name must match on both sides.

## Generate the App-Level Token

> **User action required.** **Settings → Basic Information → App-Level Tokens → Generate Token and Scopes**, add the `connections:write` scope, generate. The token starts with `xapp-` and is shown once: save it as `SLACK_APP_TOKEN` in `.env`.

## Install the App to the Workspace

> **User action required.** **Settings → Install App → Install to Workspace**, authorize. Copy the **Bot User OAuth Token** (`xoxb-…`) from **Features → OAuth & Permissions** into `SLACK_BOT_TOKEN` in `.env`.

After any scope or event change, Slack marks the app as needing re-installation: **Reinstall to Workspace** refreshes the consent and rotates the bot token.

## Invite the Bot

> **User action required.** In the target channel, run `/invite @{{DEVELOPER_NAME}}`.

The seed allowlists that one channel (`channels.slack.channels`, `groupPolicy allowlist`) and disables inbound DMs (`dmPolicy disabled`). An invite elsewhere leaves the bot silent there.

## What the App Configuration Cannot Confine

`users:read` is workspace-wide: it reads the whole member directory, and Slack offers no channel-scoped equivalent. `groups:read` covers the private channels the bot is a member of. The single-channel rule therefore rests on two other layers: the bot is invited to one channel (history and posting fail elsewhere with `not_in_channel`), and the gateway processes only the allowlisted channel ID.

## If the Channel Becomes Public

The app configuration is scoped to a private channel (`groups:*`, `message.groups`). Converting the channel to public cuts the bot off: Slack starts sending `message.channels`, which the app does not subscribe to, and history reads fail. To recover:

1. **OAuth & Permissions**: add the bot scopes `channels:history` and `channels:read`; drop the `groups:*` pair.
2. **Event Subscriptions**: add `message.channels`, drop `message.groups`.
3. **Reinstall to Workspace**. Save the rotated `xoxb-` token as `SLACK_BOT_TOKEN` and re-seed (`../operations/configure-developer.md`).
4. A conversion can change the channel ID. Confirm it, update `SLACK_CHANNEL_ID` when needed, and re-seed.

## Collect the IDs

| Variable | How to get it |
| --- | --- |
| `SLACK_BOT_TOKEN` | **OAuth & Permissions → Bot User OAuth Token** (`xoxb-…`). Reinstall the app to rotate it. |
| `SLACK_APP_TOKEN` | **Basic Information → App-Level Tokens** (`xapp-…`). Shown once at creation. |
| `SLACK_OWNER_ID` | Your Slack profile → **⋮ → Copy member ID** (`U…`). Gates admin chat commands and exec approvals. |
| `SLACK_CHANNEL_ID` | The channel → its name → **About → Channel ID** (`C…`), or the `C…` segment of the channel link. |

## Notes

- One process per app token. A second Socket Mode connection on the same token replaces the first; a local or staging bot needs its own Slack app.
- Rotating a token: regenerate it (reinstall for `xoxb-`, delete and recreate for `xapp-`), edit `infra/openclaw/.env`, then follow `../operations/configure-developer.md` (snapshot, re-seed, `openclaw secrets reload`).
- Startup logs one `[slack] channel resolve failed … missing_scope: channels:read` line: the plugin tries a public-channel lookup, fails on the trimmed scopes, and falls back to the configured channel map. Cosmetic; do not add the scope.
- `openclaw doctor` warns that `groupPolicy` is `allowlist` while `allowFrom` is empty. False positive: Slack's allowlist is the channel map, not a sender list. Do not add `allowFrom`.

## Smoke Test

Run it after `08`, as the operator, from the Slack client.

1. In the allowlisted channel, request a small read-only task against a listed project (a question about the codebase, no change).
2. The first reply opens a thread on your message. Its starter carries the task plus the known project path and ticket.
3. Answer in the thread. The fresh thread session reads the thread history, delegates the read-only task, and reports in the same thread, never in the channel root.
4. Post the same request in a channel the bot is not allowlisted in, then DM the bot. Neither gets a reply or starts work.

When a negative check fails, stop the gateway (`sudo -i -u {{SERVICE_USER}} -- systemctl --user stop openclaw-gateway`) and correct the allowlist or the DM policy before further use.
