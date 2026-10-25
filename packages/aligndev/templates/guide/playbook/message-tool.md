{{#slack}}
# Extended `message` actions on Slack

The workspace `AGENTS.md` carries the core calls for history recovery and attachments. Read this reference when you need a reaction, edit, delete, or search.
{{/slack}}
{{#discord}}
# Extended `message` actions on Discord

The workspace `AGENTS.md` carries the core calls for thread creation, history recovery, renaming, and attachments. Read this reference when you need a DM, a cross-surface post, or a reaction.
{{/discord}}

## Targets and IDs

{{#slack}}
The inbound conversation metadata provides `chat_id` and `message_id`.

For `target`, pass `chat_id` exactly as provided, including its `channel:` prefix. For `threadId`, pass only the bare thread ID.

## Supported actions

Slack supports `send`, `read`, `react`, `edit`, `delete`, `search`, and `sendAttachment`. The channel dispatcher uses `send` with an explicit `threadId` for the starter; cross-surface messages and attachments also use explicit actions. Ordinary replies in the current thread use plain delivery and must not be duplicated through `message`. Slack threads have no name and Slack has no `thread-create` or `thread-reply` action.

```jsonc
{ "action": "send", "channel": "<Slack surface id>", "target": "<channel chat_id>", "threadId": "<triggering root timestamp>", "message": "<starter>" }
```
{{/slack}}
{{#discord}}
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
{{/discord}}

## Reactions

```jsonc
{{#slack}}
{ "action": "react", "channel": "<Slack surface id>", "target": "<chat_id>", "messageId": "<message id>", "emoji": "lobster" }
{{/slack}}
{{#discord}}
{ "action": "react", "channel": "<Discord surface id>", "target": "<chat_id>", "messageId": "<message id>", "emoji": "🦞" }
{{/discord}}
```
{{#discord}}

## Attachment boundary

Discord attachments travel with `send` and its `attachments` array. Discord has no `sendAttachment` action.
{{/discord}}
