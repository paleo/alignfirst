#!/bin/sh

validate_surface() {
  require_environment SLACK_WORKSPACE_ID SLACK_CHANNEL_ID SLACK_BOT_TOKEN SLACK_APP_TOKEN

  case "$SLACK_WORKSPACE_ID:$SLACK_CHANNEL_ID" in
    *[!A-Z0-9:]*)
      echo "Slack workspace and channel IDs must contain only uppercase letters and digits." >&2
      exit 1
      ;;
  esac
}

configure_surface() {
  set_config_json channels.slack.enabled true
  set_secret_ref channels.slack.botToken SLACK_BOT_TOKEN
  set_secret_ref channels.slack.appToken SLACK_APP_TOKEN
  set_config_string channels.slack.groupPolicy allowlist
  set_config_string channels.slack.dmPolicy disabled
  set_config_json "channels.slack.channels.$SLACK_CHANNEL_ID" \
    '{"enabled":true,"requireMention":false,"allowBots":false}'
  set_config_string channels.slack.replyToMode all
  set_config_string channels.slack.thread.historyScope thread
  set_config_json channels.slack.thread.inheritParent false
  set_config_json channels.slack.thread.initialHistoryLimit 100
}
