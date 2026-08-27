#!/bin/sh

validate_surface() {
  require_environment DISCORD_GUILD_ID DISCORD_CHANNEL_ID DISCORD_BOT_TOKEN

  case "$DISCORD_GUILD_ID:$DISCORD_CHANNEL_ID" in
    *[!0-9:]*)
      echo "Discord guild and channel IDs must be numeric." >&2
      exit 1
      ;;
  esac
}

configure_surface() {
  guild_config=$(printf \
    '{"requireMention":false,"channels":{"%s":{"allow":true,"requireMention":false}}}' \
    "$DISCORD_CHANNEL_ID")

  set_config_json channels.discord.enabled true
  set_secret_ref channels.discord.token DISCORD_BOT_TOKEN
  set_config_string channels.discord.groupPolicy allowlist
  set_config_string channels.discord.dmPolicy disabled
  set_config_json channels.discord.allowBots false
  set_config_json channels.discord.dangerouslyAllowNameMatching false
  set_config_json channels.discord.intents.messageContent true
  set_config_string channels.discord.replyToMode off
  set_config_json channels.discord.thread.inheritParent false
  set_config_json "channels.discord.guilds.$DISCORD_GUILD_ID" "$guild_config"
  set_config_json tools.alsoAllow '["message"]'
}
