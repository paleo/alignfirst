# @alignfirst/openclaw-channel-mock-core

## 0.10.0

### Minor Changes

- 30b9db6: Moved to the `@alignfirst` npm scope. `alignfirst` itself stays unscoped, and the previous names are deprecated and receive no further releases.
  
  Replace the `@paleo/` prefix in your dependencies, then in the two scaffolded files that hardcode the scope as a path: the `include` of `./node_modules/@alignfirst/openclaw-test/docker-compose.yml` in `docker-compose.yml`, and `plugins.load.paths` under `node_modules/@alignfirst/openclaw-{discord,slack}-mock` in `openclaw.json`. A bumped dependency alone leaves `openclaw-test env up` failing on a missing Compose include, with the mock channels unloaded.

### Patch Changes

- 30b9db6: Added the `homepage` field pointing to https://alignfirst.paroi.tech, and a link to the product page in the README of each presented product.

> Version 0.9.0 and every version below it was published as `@paleo/openclaw-channel-mock-core`.

## 0.9.0

### Minor Changes

- 348c407: Moved Slack-shaped sends through OpenClaw core delivery.

### Patch Changes

- 348c407: Generate numeric thread IDs and retain their tool calls and costs in scenario reports through explicit bus ownership.
- 348c407: Required OpenClaw 2026.9.3 and Node 24.16+ or 26; the test image now runs Node 26.

## 0.8.0

### Minor Changes

- 6d72df2: Added configurable Slack thread routing, native starter receipt shapes, and canonical thread-session delivery. A send whose target names a stored thread now lands in that thread under its parent conversation, with or without an accompanying `threadId`. Discord-shaped `thread-create` now returns the native `{ ok, thread }` shape, with `partial: true` when the thread exists but its starter was not delivered; the former `threadId`, `target` and `message` fields are gone. Discord-shaped `thread-reply` now accepts a bare `threadId` as its delivery target, as bundled Discord does. The test-bus fault injector accepts `threadOnly: true` to fail only a threaded send.

### Patch Changes

- 6d72df2: Matched Discord thread behavior: inbound metadata uses native channel targets, `send` with `threadName` renames the resolved thread, and `thread-reply` leaves its name unchanged.

## 0.7.0

### Minor Changes

- ac9b4c5: OpenClaw 2026.8 compatibility. The core package now requires `zod` as a peer dependency (pinned to OpenClaw's version) and no longer provides the `messaging.parseExplicitTarget` handler.

## 0.6.1

### Patch Changes

- 801309f: Updated `typebox` to 1.3.16.

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
