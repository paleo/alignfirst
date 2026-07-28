# @paleo/openclaw-channel-mock-core

## 0.6.0

### Minor Changes

- 1470b76: Thread renaming, matching real Discord: `thread-create` now reads the thread name from `threadName`, and a `send` / `thread-reply` carrying `threadName` renames the target thread.

## 0.5.0

### Minor Changes

- 53fc35d: Thread inbounds now activate sessions keyed exactly like the real channels (Discord: the thread's own id as a channel peer; Slack: the `:thread:<ts>` suffix on the channel session key), and bus thread ids are prefixed with their conversation id.

### Patch Changes

- 0290042: The `read` and `search` actions now resolve every id shape the surfaces advertise — composite `thread:<conv>/<tid>` targets in `threadId`, thread-shaped `to`/`target`, the current-channel fallback when no destination is given (Discord), and a thread id in channel position. Slack-shaped `read` now requires a destination, like the real plugin.
- 0290042: Inbound dispatch is now fire-and-forget with per-message error containment, like the real channel monitors — a long agent turn no longer delays the next inbound, and a failed dispatch no longer kills the account's poll loop. Gateway logs gain one `inbound dispatch start/done` line per inbound.

## 0.4.0

### Minor Changes

- Slack-shaped channels now thread like real Slack: a root channel inbound auto-threads on the triggering message — the thread id is the message's own id, no separate thread object — and a background exec's completion wake replies in that thread instead of the channel root. Assert on observed thread ids, not on the old `thread-…` shape.

## 0.3.2

### Patch Changes

- aced48c: Upgraded to OpenClaw `2026.6.11` inbound API.

## 0.3.1

### Patch Changes

- Improved CLI argument handling

## 0.3.0

### Minor Changes

- Enhanced OpenClaw test packages

## 0.2.3

### Patch Changes

- Improved documentation

## 0.2.2

### Patch Changes

- Fixed configuration

## 0.2.1

### Patch Changes

- Hardened openclaw qa toolkit

## 0.2.0

### Minor Changes

- Initial version
