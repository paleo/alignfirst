#!/usr/bin/env bash
#
# Discord surface module (one allowlisted guild channel, DMs by pairing, owner pre-trusted).
# Sourced by seed.sh after seed/common.sh; not meant to run on its own.

required_surface=(DISCORD_BOT_TOKEN DISCORD_OWNER_ID DISCORD_GUILD_ID DISCORD_CHANNEL_ID)
secret_variables_surface=(DISCORD_BOT_TOKEN)
surface_plugin_id=discord

validate_surface() {
  local name
  for name in DISCORD_OWNER_ID DISCORD_GUILD_ID DISCORD_CHANNEL_ID; do
    if ! [[ "${!name}" =~ ^[0-9]+$ ]]; then
      echo "[seed] $name must be a numeric Discord snowflake, got: ${!name}" >&2
      exit 1
    fi
  done
}

configure_surface() {
  echo "[seed] plugin — @openclaw/discord"
  # External npm plugin; installed under ~/.openclaw/npm/ (layout varies across versions).
  if ! find "$HOME/.openclaw/npm" -maxdepth 6 -type d -path '*/node_modules/@openclaw/discord' \
    2>/dev/null | grep -q .; then
    openclaw plugins install @openclaw/discord --accept-capabilities
  fi
  set_json plugins.entries.discord.enabled true
  # Capability consent is recorded per plugin version, outside openclaw.json; a version bump
  # needs it again. Idempotent.
  openclaw plugins enable discord --accept-capabilities

  echo "[seed] Discord channel — single guild channel, DMs by pairing"
  # A wake report follows the last conversation, which may be a paired DM. The explicit value
  # (the default) also stops doctor's security check from asking for a pin.
  set_scalar agents.defaults.heartbeat.directPolicy allow
  set_json channels.discord.enabled true
  set_secret_ref channels.discord.token /DISCORD_BOT_TOKEN
  # The owner is pre-trusted; another DM sender gets a pairing code (operations/pair-dm-sender.md).
  set_scalar channels.discord.dmPolicy pairing
  set_json channels.discord.allowFrom "[\"$DISCORD_OWNER_ID\"]"
  # Unset falls back to "open": any guild member could trigger the bot from any channel.
  set_scalar channels.discord.groupPolicy allowlist
  # Per-channel key is `enabled` (DiscordGuildChannelConfig). The whole map, so a re-seed with a new
  # channel ID replaces the old one.
  local channel_config="{\"$DISCORD_CHANNEL_ID\":{\"enabled\":true,\"requireMention\":false}}"
  set_json channels.discord.guilds "{\"$DISCORD_GUILD_ID\":{\"channels\":$channel_config}}"
  # Completed paragraphs as they finish; no tool-progress previews in the channel.
  set_json channels.discord.streaming '{"mode":"block","preview":{"toolProgress":false}}'
  # Thread sessions start fresh; the playbook recovers the history with `message` action "read"
  # (Discord has no initialHistoryLimit).
  set_json channels.discord.thread '{"inheritParent":false}'
  # spawnSessions false keeps threads on the fresh-session path: the channel session opens the
  # thread with `thread-create`, never with a spawned subagent.
  set_json channels.discord.threadBindings \
    '{"enabled":true,"idleHours":60,"maxAgeHours":0,"spawnSessions":false}'
  # Privileged intent; also enabled on the application's Bot page (07-channel.md).
  set_json channels.discord.intents.messageContent true

  echo "[seed] owner allowlist — admin chat commands and exec approvals"
  set_json commands.ownerAllowFrom "[\"discord:$DISCORD_OWNER_ID\"]"
}
