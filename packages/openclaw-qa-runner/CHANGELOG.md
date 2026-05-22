# @paleo/openclaw-qa-runner

## 0.3.0

### Minor Changes

- Improved CLI
- Add host-side `openclaw-qa-runner env build|up|down` and `openclaw-qa-runner qa` subcommands. The CLI auto-derives `QA_PROJECT_DIR`, `QA_RUNNER_PACKAGE_DIR`, `CLAW_UID`, `CLAW_GID`, and resolves relative paths from `.env.local` against the consumer's qa dir. All other path env vars default to subdirs of `QA_PROJECT_DIR`. Consumer `package.json` scripts collapse to one-liners.

  Breaking: `bin/qa.mjs` removed. Migrate scripts to `openclaw-qa-runner env build|up|down` / `openclaw-qa-runner qa`. Move project-specific paths from inline env preludes into `.env.local`.

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
