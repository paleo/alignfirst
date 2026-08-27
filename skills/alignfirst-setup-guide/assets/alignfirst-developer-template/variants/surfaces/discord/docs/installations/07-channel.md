---
title: Discord Channel Setup
read_when:
  - connecting the developer to its selected Discord channel
---

# Discord Channel Setup

**Role: Discord administrator** for application creation, then **service user** for configuration.
Token creation and entry are human-only steps.

## Create and Install the Bot

Follow Discord's [application and bot
quickstart](https://docs.discord.com/developers/quick-start/getting-started). Create one application
and bot, then enable the privileged **Message Content Intent**. Install the bot in guild
`{{DISCORD_GUILD_ID}}` with the `bot` and `applications.commands` scopes.

Grant only the permissions required for this workflow: View Channels, Send Messages, Read Message
History, Create Public Threads, Send Messages in Threads, Embed Links, and Attach Files. Add
Reactions only when wanted. Do not grant Administrator. Install the official channel plugin for the
service user:

```sh
openclaw plugins install @openclaw/discord
```

Enable Discord Developer Mode and confirm the selected text channel ID is
`{{DISCORD_CHANNEL_ID}}`. The configuration uses numeric IDs and rejects every other guild/channel.

## Enter the Token

**Role: human service operator.** Reset and copy the bot token in the Developer Portal. Enter it
with an editor in `infra/openclaw/secrets/environment`:

```text
DISCORD_BOT_TOKEN=<bot token>
```

Never paste it into chat, a tracked file, or a command line. Confirm the file contains the
non-secret guild/channel IDs from `.env.example`, then apply the seed:

```sh
chmod 0600 infra/openclaw/secrets/environment
infra/openclaw/seed.sh
openclaw config validate
openclaw secrets audit
openclaw channels status --probe
```

DMs are disabled. Automatic reply threading and parent-transcript inheritance are off. The coding
tool profile is widened only with `message`, allowing the channel session to call `thread-create`.
The thread starter must carry project, canonical path, ticket when present, audience, and task. A
fresh thread session recovers that starter with `message` action `read` against its bound thread.

## Smoke Test

1. In the allowed channel, request a small read-only AlignFirst protocol task against a known
   project.
2. Confirm the channel session creates one named thread with a complete starter and posts no
   duplicate starter or setup message in the channel root.
3. Send a follow-up in the thread. Confirm the fresh session reads its own history, delegates the
   read-only task, and returns the completion to that thread.
4. Repeat from an unlisted channel or guild. It must not create a thread or start work.
5. Confirm the channel root received neither the working report nor a duplicate completion.

If a negative check fails, stop the gateway and correct the allowlist or delivery behavior before
use.
