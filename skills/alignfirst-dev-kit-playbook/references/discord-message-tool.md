# Extended `message` actions on Discord

The workspace `AGENTS.md` carries the core calls for thread creation, history recovery, renaming, and attachments. Read this reference when you need a DM, a cross-surface post, or a reaction.

## Targets and IDs

The inbound conversation metadata provides `chat_id`, `message_id`, and the guild's `group_space`.

For `target`, pass `chat_id` exactly as provided. Keep the prefix: `"channel:<id>"` for channels and threads, `"user:<id>"` for DMs. An unprefixed ID is ambiguous.

For `threadId`, pass only the bare thread ID from the conversation metadata or a `thread-create` result. Never pass a `thread:<channel>/<id>` target as `threadId`.

## Cross-surface posts

Use `message` actions for cross-surface posts, never a raw provider API. Plain text already delivers to your bound surface.

Post into another thread:

```jsonc
{ "action": "thread-reply", "channel": "<Discord surface id>", "threadId": "<bare thread id>", "message": "<text>" }
```

Post into a channel or DM:

```jsonc
{ "action": "send", "channel": "<Discord surface id>", "target": "<channel:... or user:... chat_id>", "message": "<text>" }
```

## Reactions

```jsonc
{ "action": "react", "channel": "<Discord surface id>", "target": "<chat_id>", "messageId": "<message id>", "emoji": "👀" }
```

## Attachment boundary

Discord attachments travel with `send` and its `attachments` array. Discord has no `sendAttachment` action.
