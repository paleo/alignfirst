# @paleo/openclaw-test

## 0.6.1

### Patch Changes

- 9cbaaff: Run the LLM judge at `temperature: 0` for deterministic verdicts.

## 0.6.0

### Minor Changes

- `ScenarioReport` schema bumped to `schemaVersion: 2`. Cleaner separation of concerns between the two artifact files.

## 0.5.2

### Patch Changes

- Silence two cosmetic warnings on a fresh consumer `env:build`.
- Updated dependencies
  - @paleo/openclaw-discord-mock@0.3.2
  - @paleo/openclaw-slack-mock@0.3.2

## 0.5.1

### Patch Changes

- Improved CLI argument handling
- Updated dependencies
  - @paleo/openclaw-channel-mock-core@0.3.1
  - @paleo/openclaw-discord-mock@0.3.1
  - @paleo/openclaw-slack-mock@0.3.1

## 0.5.0

### Minor Changes

- Enhanced OpenClaw test packages

### Patch Changes

- Updated dependencies
  - @paleo/openclaw-channel-mock-core@0.3.0
  - @paleo/openclaw-discord-mock@0.3.0
  - @paleo/openclaw-slack-mock@0.3.0

## 0.4.1

### Patch Changes

- Improved documentation
- Updated dependencies
  - @paleo/openclaw-channel-mock-core@0.2.3
  - @paleo/openclaw-discord-mock@0.2.3
  - @paleo/openclaw-slack-mock@0.2.3

## 0.4.0

### Minor Changes

- 08e6d7a: Ships a consumer-agnostic `Dockerfile.base` and a consumer `templates/Dockerfile` that `FROM`s it.

## 0.3.2

### Patch Changes

- Addressed CLI-side path defaults, doc fixes

## 0.3.1

### Patch Changes

- Fixed env variable names

## 0.3.0

### Minor Changes

- Improved CLI
- Add host-side `openclaw-test env build|up|down` and `openclaw-test qa` subcommands. The CLI auto-derives `QA_PROJECT_DIR`, `QA_RUNNER_PACKAGE_DIR`, `CLAW_UID`, `CLAW_GID`, and resolves relative paths from `.env.local` against the consumer's qa dir. All other path env vars default to subdirs of `QA_PROJECT_DIR`. Consumer `package.json` scripts collapse to one-liners.

  Breaking: `bin/qa.mjs` removed. Migrate scripts to `openclaw-test env build|up|down` / `openclaw-test qa`. Move project-specific paths from inline env preludes into `.env.local`.

## 0.2.2

### Patch Changes

- Fixed configuration
- Updated dependencies
  - @paleo/openclaw-channel-mock-core@0.2.2
  - @paleo/openclaw-discord-mock@0.2.2
  - @paleo/openclaw-slack-mock@0.2.2

## 0.2.1

### Patch Changes

- Hardened openclaw qa toolkit
- Updated dependencies
  - @paleo/openclaw-channel-mock-core@0.2.1
  - @paleo/openclaw-discord-mock@0.2.1
  - @paleo/openclaw-slack-mock@0.2.1

## 0.2.0

### Minor Changes

- Initial version

### Patch Changes

- Updated dependencies
  - @paleo/openclaw-channel-mock-core@0.2.0
  - @paleo/openclaw-discord-mock@0.2.0
  - @paleo/openclaw-slack-mock@0.2.0
