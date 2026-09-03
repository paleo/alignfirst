#!/usr/bin/env bash
#
# Slack surface module (Socket Mode, one allowlisted private channel, DMs disabled).
# Sourced by seed.sh after seed/common.sh; not meant to run on its own.

required_surface=(SLACK_BOT_TOKEN SLACK_APP_TOKEN SLACK_OWNER_ID SLACK_CHANNEL_ID)
secret_variables_surface=(SLACK_BOT_TOKEN SLACK_APP_TOKEN)
surface_plugin_id=slack

validate_surface() {
  if ! [[ "$SLACK_CHANNEL_ID" =~ ^[A-Z0-9]+$ ]]; then
    echo "[seed] SLACK_CHANNEL_ID must be a Slack channel ID (C…), got: $SLACK_CHANNEL_ID" >&2
    exit 1
  fi
  if ! [[ "$SLACK_OWNER_ID" =~ ^[UW][A-Z0-9]+$ ]]; then
    echo "[seed] SLACK_OWNER_ID must be a Slack member ID (U…), got: $SLACK_OWNER_ID" >&2
    exit 1
  fi
}

configure_surface() {
  echo "[seed] plugin — @openclaw/slack"
  install_plugin_once @openclaw/slack
  # Enables the plugin and records the capability consent, kept per plugin version outside
  # openclaw.json, so a version bump needs it again. Idempotent.
  openclaw plugins enable slack --accept-capabilities

  echo "[seed] Slack channel — Socket Mode, single channel, DMs disabled"
  # Inbound DMs are disabled, so heartbeat wake reports never target a DM. The explicit value
  # also stops doctor's security check from asking for a pin.
  set_scalar agents.defaults.heartbeat.directPolicy block
  set_json channels.slack.enabled true
  set_secret_ref channels.slack.botToken /SLACK_BOT_TOKEN
  set_secret_ref channels.slack.appToken /SLACK_APP_TOKEN
  # A previous open-DM seed may have set allowFrom ["*"], valid only with dmPolicy "open".
  unset_key channels.slack.allowFrom
  set_scalar channels.slack.dmPolicy disabled
  # Slack cannot pin a bot to a channel; the gateway does: only the listed channel is answered.
  set_scalar channels.slack.groupPolicy allowlist
  # The whole map, so a re-seed with a new channel ID replaces the old one. Invite the bot there.
  set_json channels.slack.channels \
    "{\"$SLACK_CHANNEL_ID\":{\"enabled\":true,\"requireMention\":false}}"
  # Completed paragraphs as they finish; no tool-progress previews in the channel.
  set_json channels.slack.streaming '{"mode":"block","preview":{"toolProgress":false}}'
  # Every reply threads on the triggering message; a thread runs as a fresh session that
  # ingests up to 100 prior thread messages on its first turn.
  set_scalar channels.slack.replyToMode all
  set_json channels.slack.thread \
    '{"historyScope":"thread","inheritParent":false,"initialHistoryLimit":100}'
  # The name must match the slash command declared in the Slack app configuration (07-channel.md).
  set_json channels.slack.slashCommand '{"enabled":true,"name":"openclaw"}'

  echo "[seed] owner allowlist — admin chat commands and exec approvals"
  set_json commands.ownerAllowFrom "[\"slack:$SLACK_OWNER_ID\"]"
}
