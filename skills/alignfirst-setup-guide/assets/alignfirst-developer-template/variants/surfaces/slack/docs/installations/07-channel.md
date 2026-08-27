---
title: Slack Channel Setup
read_when:
  - connecting the developer to its selected Slack channel
---

# Slack Channel Setup

**Role: Slack administrator** for app creation, then **service user** for configuration. Token
creation and entry are human-only steps.

## Create and Install the App

Use Slack's current [OpenClaw Socket Mode
app](https://docs.slack.dev/ai/openclaw-slack-plugin/) or reproduce its manifest. Install the
official plugin for the service user:

```sh
openclaw plugins install @openclaw/slack
```

The app needs Socket Mode, an app-level token with `connections:write`, and a bot token. Use the
official manifest's bot scopes and events; they cover channel and thread history, messages, files,
reactions, users, and mentions. Remove direct-message scopes only if Slack permits that reduction
without changing channel operation. This deployment disables DMs in OpenClaw.

Install the app in workspace `{{SLACK_WORKSPACE_ID}}`, invite it to channel
`{{SLACK_CHANNEL_ID}}`, and confirm no broader Slack channel is intended. Record IDs, not names.

## Enter the Tokens

**Role: human service operator.** Edit `infra/openclaw/secrets/environment` with an editor that does
not place values in shell history:

```text
SLACK_BOT_TOKEN=<xoxb token>
SLACK_APP_TOKEN=<xapp token>
```

Never paste either value into chat, a tracked file, or a command line. Confirm the file contains the
non-secret workspace/channel IDs from `.env.example`, then apply the seed:

```sh
chmod 0600 infra/openclaw/secrets/environment
infra/openclaw/seed.sh
openclaw config validate
openclaw secrets audit
openclaw channels status --probe
```

The generated configuration allowlists one channel, disables DMs, replies in a thread for every
channel response, and injects up to 100 initial thread messages. The channel session only creates
the starter; substantive setup and delegation belong to the resulting thread session.

## Smoke Test

1. In the allowed channel, request a small read-only AlignFirst protocol task against a known
   project.
2. Open the automatic reply thread and confirm its starter retains the project, canonical path,
   ticket when present, audience, and task.
3. Continue in that thread. Confirm the agent delegates the read-only task and the final report
   returns to the same thread, never the channel root.
4. Post in an unlisted channel and DM the bot. Neither request may start work or receive a developer
   response.

If a negative check fails, stop the gateway and correct the allowlist or DM policy before use.
