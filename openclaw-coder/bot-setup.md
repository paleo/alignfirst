# Channel bot setup — Discord & Slack

Provider-side settings for running `myclaw` against **real** Discord and Slack workspaces. None of this is needed for the [`playbook-test/`](playbook-test/) harness, which drives the workspace through synthetic `discord-mock` / `slack-mock` channels.

Both channels run **Socket Mode / outbound only** — the bot opens an outbound WebSocket, so no public URL, webhook, or inbound firewall rule is required. The settings below feed the channel credentials your OpenClaw instance reads (`channels.discord.*`, `channels.slack.*` in `openclaw.json`, or the matching `DISCORD_*` / `SLACK_*` env vars your seed script consumes).

## Discord

### Enable Developer Mode

Discord client → **Settings → Advanced → Developer Mode** → enable. (Needed to copy IDs.)

### Create the bot application

1. Sign in to <https://discord.com/developers/applications> and click **New Application**. Name it after the agent (e.g. `myclaw`).
2. Under **Installation**, set **Install Link** to **None** and save — prerequisite for making the bot private in the next step.
3. Under **Bot**:
   - Click **Reset Token** and save the value to your Discord bot token. Shown only once — losing it means resetting again.
   - Uncheck **Public Bot** and save.
   - Under **Privileged Gateway Intents**, enable **Message Content Intent**. Without it the bot receives empty message bodies.
4. Under **OAuth2 → URL Generator**, select:
   - Scopes: `bot`, `applications.commands`
   - Bot Permissions — General: **View Channels**
   - Bot Permissions — Text: **Send Messages**, **Create Public Threads**, **Create Private Threads**, **Send Messages in Threads**, **Pin Messages**, **Attach Files**, **Read Message History**, **Add Reactions**, **Create Polls**, **Bypass Slowmode**
5. Copy the generated URL, open it in a browser, and authorize the bot into the target server. You need **Manage Server** on that server.

### Wire up the server and channel

1. Create (or pick) the private channel the bot listens on. Right-click the channel → **Edit Channel → Permissions** → add the bot role and grant View Channel + Send Messages.
2. Collect the IDs:

| Value | How to get it |
|---|---|
| Bot token | Bot page, "Reset Token". Must be unique per running instance. |
| Owner ID | Right-click your own user → Copy ID. |
| Guild (server) ID | Right-click the server icon → Copy Server ID. |
| Channel ID | Right-click the target channel → Copy Channel ID. |

### Notes

- Only one process can connect to Discord with a given bot token at a time. A second instance disconnects the first — use a separate application (and token) for any local / staging bot.
- Rotating the token: reset on the Bot page, update your config, then re-seed OpenClaw (or `openclaw config set channels.discord.token "<new>"` on a running agent and restart).
- The thread-routing knobs `myclaw` expects (`tools.alsoAllow: ["message"]`, `spawnSessions: false`, `thread.inheritParent: false`) are explained in [`../docs/openclaw-context-engineering.md`](../docs/openclaw-context-engineering.md#wiring-it-up).

## Slack

OpenClaw uses Slack in **Socket Mode**. Two tokens: a **bot token** (`xoxb-…`) for posting/reading and an **app-level token** (`xapp-…`) that only opens the WebSocket. Upstream reference: `docs/channels/slack.md` in the `openclaw` package.

### Create the Slack app from a manifest

The upstream-canonical manifest is faster and less error-prone than clicking through 20+ scope checkboxes.

1. Go to <https://api.slack.com/apps/new> → **From a manifest** → pick the target workspace → paste the JSON below → **Create**.
2. Leave **Distribution** off — the app stays private to the workspace.

Slack validates assistant apps two ways relevant here: bot scope `assistant:write` must pair with `features.assistant_view`, and Assistant View expects bot event `assistant_thread_started`. The JSON below satisfies both.

```json
{
  "display_information": {
    "name": "myclaw",
    "description": "Slack connector for OpenClaw"
  },
  "features": {
    "bot_user": { "display_name": "myclaw", "always_online": true },
    "app_home": {
      "home_tab_enabled": true,
      "messages_tab_enabled": true,
      "messages_tab_read_only_enabled": false
    },
    "assistant_view": {
      "assistant_description": "Slack connector for OpenClaw — mentions and DMs."
    },
    "slash_commands": [
      {
        "command": "/openclaw",
        "description": "Send a message to OpenClaw",
        "should_escape": false
      }
    ]
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "app_mentions:read",
        "assistant:write",
        "channels:history",
        "channels:read",
        "chat:write",
        "commands",
        "emoji:read",
        "files:read",
        "files:write",
        "groups:history",
        "groups:read",
        "im:history",
        "im:read",
        "im:write",
        "mpim:history",
        "mpim:read",
        "mpim:write",
        "pins:read",
        "pins:write",
        "reactions:read",
        "reactions:write",
        "usergroups:read",
        "users:read"
      ]
    }
  },
  "settings": {
    "socket_mode_enabled": true,
    "event_subscriptions": {
      "bot_events": [
        "app_home_opened",
        "app_mention",
        "assistant_thread_started",
        "channel_rename",
        "member_joined_channel",
        "member_left_channel",
        "message.channels",
        "message.groups",
        "message.im",
        "message.mpim",
        "pin_added",
        "pin_removed",
        "reaction_added",
        "reaction_removed"
      ]
    }
  }
}
```

The slash command `/openclaw` is registered but dormant — `channels.slack.slashCommand.enabled` defaults to `false`. To enable later, match the command name in both Slack (manifest) and OpenClaw config.

### Generate the app-level token

**Settings → Basic Information → App-Level Tokens → Generate Token and Scopes**, add `connections:write`, generate. Starts with `xapp-`, shown once — save it. App-level tokens authorize the WebSocket only; they cannot read or post messages.

### Install the app to the workspace

**Settings → Install App → Install to \<Workspace\>**, authorize. The **Bot User OAuth Token** appears under **Features → OAuth & Permissions** — starts with `xoxb-`. Save it. If you later change scopes or events, Slack marks the app as needing re-installation — click **Reinstall to \<Workspace\>** to refresh consent and the bot token.

### Invite the bot into a channel

```text
/invite @myclaw
```

### Collect the IDs

| Value | How to get it |
|---|---|
| Bot token (`xoxb-…`) | OAuth & Permissions → "Bot User OAuth Token". Reinstall app to rotate. |
| App token (`xapp-…`) | Basic Information → App-Level Tokens. Shown once at creation. |
| Owner ID (`U…`) | Click your name → **View full profile** → ⋮ → **Copy member ID**. |

### Notes

- One process per app token. A second Socket Mode connection replaces the first — use a separate Slack app (its own `xoxb-` + `xapp-`) for any local / staging bot.
- Slack's built-in auto-thread (`replyToMode: "all"`) + `thread.initialHistoryLimit: 100` give the per-thread session model with history seeding for free — the shape `myclaw` relies on. See [`../docs/openclaw-context-engineering.md`](../docs/openclaw-context-engineering.md#patterns-for-thread-work).
- Rotating tokens: regenerate (Reinstall App for `xoxb-`, delete-and-recreate for `xapp-`), update config, then re-seed (or `openclaw config set channels.slack.{botToken,appToken} "<new>"`) and restart the gateway.
