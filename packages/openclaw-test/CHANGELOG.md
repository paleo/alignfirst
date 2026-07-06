# @paleo/openclaw-test

## 0.13.0

### Minor Changes

- 1298d34: Parallel runs: `run --parallel <K>` and `env up --parallel <K>` (default `OPENCLAW_TEST_PARALLEL`) run matrix cells concurrently on K worker Compose stacks (`<project>-w<i>`); the flag-less `env down` tears them all down. Gitignore the new `.workers/` directory. One-time upgrade step: run `docker compose down` once on the legacy un-suffixed Compose project.

### Patch Changes

- Updated dependencies [0290042]
- Updated dependencies [0290042]
- Updated dependencies [53fc35d]
  - @paleo/openclaw-channel-mock-core@0.5.0
  - @paleo/openclaw-discord-mock@0.3.5
  - @paleo/openclaw-slack-mock@0.3.5

## 0.12.2

### Patch Changes

- Updated dependencies
  - @paleo/openclaw-channel-mock-core@0.4.0
  - @paleo/openclaw-discord-mock@0.3.4
  - @paleo/openclaw-slack-mock@0.3.4

## 0.12.1

### Patch Changes

- aced48c: Fix the intermittent post-verdict runner hang. The QA-bus long-poll now runs under a client-side `AbortController` (server hold + 2s) so a wedged bus or half-open connection surfaces as an empty poll and the caller's deadline loop keeps ticking instead of hanging forever. On shutdown the mock CLI server force-closes lingering keep-alive sockets (`closeAllConnections`) so `close()` resolves at once rather than waiting on an idle-open connection.
- Updated dependencies [aced48c]
  - @paleo/openclaw-channel-mock-core@0.3.2
  - @paleo/openclaw-discord-mock@0.3.3
  - @paleo/openclaw-slack-mock@0.3.3

## 0.12.0

### Minor Changes

- Aggregate trajectory across all conversation sessions (channel + thread + subagents) so reports and cost capture every turn, not just the first. Adds `ctx.waitForAgentToolCall` for asserting agent tool calls.

## 0.11.0

### Minor Changes

- 4107ff1: `init` now adds the four `package.json` scripts (`env:build`, `env:up`, `env:down`, `e2e`) when missing — existing scripts are never overwritten — and prints the next steps. Simplified README.

## 0.10.0

### Minor Changes

- Switched test harness to OpenRouter (Qwen 3.6 Plus)

## 0.9.0

### Minor Changes

- Compact `report.json` (full values stay in `scenario-log.jsonl`): truncate `read` tool result content, and replace the `scenarioLog` note's `prefix`/`message` with `label?`/`extra?` so it no longer echoes the entry's `text`.

## 0.8.1

### Patch Changes

- Cell names lead with the model, then the scenario

## 0.8.0

### Minor Changes

- 7d1b19f: Cell dir names now order segments `scenario → model → channel` with a `#`-prefixed iteration (`…-<model>-<channel>-#<NN>`); `--model`/`--channel` `all` sort alphabetically, explicit lists dedupe in CLI order (model still runs outermost).

## 0.7.0

### Minor Changes

- 635dc4a: `run --model` now accepts a comma list of bare ids (e.g. `--model claude-sonnet-4-6,qwen3.6-plus`), matching `--channel`. Both flags dedupe repeated ids.

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
