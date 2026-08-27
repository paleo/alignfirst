---
title: Discord Channel
read_when:
  - creating the Discord application that feeds the DISCORD_* variables of .env
  - rotating the bot token or moving the bot to another channel
  - running the channel smoke test after the developer is installed
---

# Discord Channel

**Role: Discord administrator** for the platform setup, **operator** for the smoke test. Platform setup runs before `04` (its token and IDs go into `infra/openclaw/.env`); the smoke test runs after `08`.

## Enable Developer Mode

> **User action required.** Discord client → **Settings → Advanced → Developer Mode** → enable. It adds **Copy ID** to the right-click menus used below.

## Create the Application

> **User action required.** Sign in to <https://discord.com/developers/applications> and click **New Application**. Name it `{{DEVELOPER_NAME}}`, then:
>
> 1. **Installation**: set **Install Link** to **None** and save. The private-bot switch below depends on it.
> 2. **Bot**: click **Reset Token** and save the value as `DISCORD_BOT_TOKEN` in `.env`. The token is shown once; losing it means resetting again.
> 3. **Bot**: uncheck **Public Bot** and save.
> 4. **Bot → Privileged Gateway Intents**: enable **Message Content Intent**. Without it the bot receives empty message bodies.

## Authorize the Bot into the Server

> **User action required.** Under **OAuth2 → URL Generator**, select the scopes `bot` and `applications.commands`, then the bot permissions:
>
> - General: **View Channels**
> - Text: **Send Messages**, **Create Public Threads**, **Create Private Threads**, **Send Messages in Threads**, **Manage Threads**, **Pin Messages**, **Attach Files**, **Read Message History**, **Add Reactions**
>
> Open the generated URL in a browser and authorize the bot into the target server. The authorizing account needs **Manage Server** there.

**Manage Threads** is required: the playbook renames a thread as soon as it knows the ticket and the task. Do not grant Administrator.

## Channel Permissions

> **User action required.** Create or pick the private channel the bot listens on. Right-click it → **Edit Channel → Permissions** → add the bot role and grant **View Channel** and **Send Messages**.

The seed allowlists that one channel (`channels.discord.guilds`, `groupPolicy allowlist`). A message from another channel or guild is ignored. DMs use `dmPolicy pairing`: the owner is pre-trusted, anyone else is approved through `../operations/pair-dm-sender.md`.

## Collect the IDs

| Variable | How to get it |
| --- | --- |
| `DISCORD_BOT_TOKEN` | Application → **Bot → Reset Token**. Unique per running instance. |
| `DISCORD_OWNER_ID` | Right-click your own name → **Copy User ID**. Gates admin chat commands, exec approvals, and the pre-trusted DM. |
| `DISCORD_GUILD_ID` | Right-click the server icon → **Copy Server ID**. |
| `DISCORD_CHANNEL_ID` | Right-click the target channel → **Copy Channel ID**. |

## Notes

- One connected process per token. A second instance disconnects the first; a local or staging bot needs its own application and token.
- Rotating the token: **Reset Token** on the Bot page, edit `DISCORD_BOT_TOKEN` in `infra/openclaw/.env`, then follow `../operations/configure-developer.md` (snapshot, re-seed, `openclaw secrets reload`).

## Smoke Test

Run it after `08`, as the operator, from the Discord client.

1. In the allowlisted channel, request a small read-only task against a registered project (a question about the codebase, no change).
2. The channel session creates one named thread on your message. Its starter carries the task plus the known project path and ticket. The channel root receives no duplicate starter and no setup message.
3. Answer in the thread. The fresh thread session reads its own history, delegates the read-only task, and reports in the same thread.
4. Post the same request in a channel or guild the bot is not allowlisted in. No thread opens, no work starts.
5. The channel root received neither the report nor a duplicate completion.

When a negative check fails, stop the gateway (`sudo -i -u {{SERVICE_USER}} -- systemctl --user stop openclaw-gateway`) and correct the allowlist or the delivery settings before further use.
