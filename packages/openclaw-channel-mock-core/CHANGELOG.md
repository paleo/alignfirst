# @paleo/openclaw-channel-mock-core

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
