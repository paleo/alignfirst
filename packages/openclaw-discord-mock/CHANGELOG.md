# @alignfirst/openclaw-discord-mock

## 0.6.0

### Minor Changes

- 30b9db6: Moved to the `@alignfirst` npm scope. `alignfirst` itself stays unscoped, and the previous names are deprecated and receive no further releases.
  
  Replace the `@paleo/` prefix in your dependencies, then in the two scaffolded files that hardcode the scope as a path: the `include` of `./node_modules/@alignfirst/openclaw-test/docker-compose.yml` in `docker-compose.yml`, and `plugins.load.paths` under `node_modules/@alignfirst/openclaw-{discord,slack}-mock` in `openclaw.json`. A bumped dependency alone leaves `openclaw-test env up` failing on a missing Compose include, with the mock channels unloaded.

### Patch Changes

- 30b9db6: Added the `homepage` field pointing to https://alignfirst.paroi.tech, and a link to the product page in the README of each presented product.
- Updated dependencies [30b9db6]
- Updated dependencies [30b9db6]
  - @alignfirst/openclaw-channel-mock-core@0.10.0

> Version 0.5.0 and every version below it was published as `@paleo/openclaw-discord-mock`.

## 0.5.0

### Minor Changes

- 348c407: Required OpenClaw 2026.9.3 and Node 24.16+ or 26; the test image now runs Node 26.

### Patch Changes

- Updated dependencies [348c407]
- Updated dependencies [348c407]
- Updated dependencies [348c407]
  - @alignfirst/openclaw-channel-mock-core@0.9.0

## 0.4.0

### Minor Changes

- 6d72df2: Added configurable Slack thread routing, native starter receipt shapes, and canonical thread-session delivery. A send whose target names a stored thread now lands in that thread under its parent conversation, with or without an accompanying `threadId`. Discord-shaped `thread-create` now returns the native `{ ok, thread }` shape, with `partial: true` when the thread exists but its starter was not delivered; the former `threadId`, `target` and `message` fields are gone. Discord-shaped `thread-reply` now accepts a bare `threadId` as its delivery target, as bundled Discord does. The test-bus fault injector accepts `threadOnly: true` to fail only a threaded send.

### Patch Changes

- Updated dependencies [6d72df2]
- Updated dependencies [6d72df2]
  - @alignfirst/openclaw-channel-mock-core@0.8.0

## 0.3.8

### Patch Changes

- ac9b4c5: OpenClaw 2026.8 compatibility. The core package now requires `zod` as a peer dependency (pinned to OpenClaw's version) and no longer provides the `messaging.parseExplicitTarget` handler.
- Updated dependencies [ac9b4c5]
  - @alignfirst/openclaw-channel-mock-core@0.7.0

## 0.3.7

### Patch Changes

- Updated dependencies [801309f]
  - @alignfirst/openclaw-channel-mock-core@0.6.1

## 0.3.6

### Patch Changes

- Updated dependencies [1470b76]
  - @alignfirst/openclaw-channel-mock-core@0.6.0

## 0.3.5

### Patch Changes

- Updated dependencies [0290042]
- Updated dependencies [0290042]
- Updated dependencies [53fc35d]
  - @alignfirst/openclaw-channel-mock-core@0.5.0

## 0.3.4

### Patch Changes

- Updated dependencies
  - @alignfirst/openclaw-channel-mock-core@0.4.0

## 0.3.3

### Patch Changes

- Updated dependencies [aced48c]
  - @alignfirst/openclaw-channel-mock-core@0.3.2

## 0.3.2

### Patch Changes

- Silence two cosmetic warnings on a fresh consumer `env:build`.

## 0.3.1

### Patch Changes

- Updated dependencies
  - @alignfirst/openclaw-channel-mock-core@0.3.1

## 0.3.0

### Minor Changes

- Enhanced OpenClaw test packages

### Patch Changes

- Updated dependencies
  - @alignfirst/openclaw-channel-mock-core@0.3.0

## 0.2.3

### Patch Changes

- Improved documentation
- Updated dependencies
  - @alignfirst/openclaw-channel-mock-core@0.2.3

## 0.2.2

### Patch Changes

- Fixed configuration
- Updated dependencies
  - @alignfirst/openclaw-channel-mock-core@0.2.2

## 0.2.1

### Patch Changes

- Hardened openclaw qa toolkit
- Updated dependencies
  - @alignfirst/openclaw-channel-mock-core@0.2.1

## 0.2.0

### Minor Changes

- Initial version

### Patch Changes

- Updated dependencies
  - @alignfirst/openclaw-channel-mock-core@0.2.0
