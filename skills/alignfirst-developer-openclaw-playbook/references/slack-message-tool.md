# Extended `message` actions on Slack

The workspace `AGENTS.md` carries the core calls for history recovery and attachments. Read this reference when you need a reaction, edit, delete, or search.

## Targets and IDs

The inbound conversation metadata provides `chat_id` and `message_id`.

For `target`, pass `chat_id` exactly as provided, including its `channel:` prefix. For `threadId`, pass only the bare thread ID.

## Supported actions

Slack supports `send`, `read`, `react`, `edit`, `delete`, `search`, and `sendAttachment`. The channel dispatcher uses `send` with an explicit `threadId` for the starter; cross-surface messages and attachments also use explicit actions. Ordinary replies in the current thread use plain delivery and must not be duplicated through `message`. Slack threads have no name and Slack has no `thread-create` or `thread-reply` action.

```jsonc
{ "action": "send", "channel": "<Slack surface id>", "target": "<channel chat_id>", "threadId": "<triggering root timestamp>", "message": "<starter>" }
```

## Reactions

```jsonc
{ "action": "react", "channel": "<Slack surface id>", "target": "<chat_id>", "messageId": "<message id>", "emoji": "eyes" }
```
