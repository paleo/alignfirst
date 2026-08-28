# Extended `message` actions on Slack

The workspace `AGENTS.md` carries the core calls for history recovery and attachments. Read this reference when you need a reaction, edit, delete, or search.

## Targets and IDs

The inbound conversation metadata provides `chat_id` and `message_id`.

For `target`, pass `chat_id` exactly as provided, including its `channel:` prefix. For `threadId`, pass only the bare thread ID.

## Supported actions

Slack supports `read`, `react`, `edit`, `delete`, `search`, and `sendAttachment`. Plain replies auto-thread, and Slack threads have no name. Slack has no `send`, `thread-create`, or `thread-reply` action.

## Reactions

```jsonc
{ "action": "react", "channel": "<Slack surface id>", "target": "<chat_id>", "messageId": "<message id>", "emoji": "eyes" }
```
