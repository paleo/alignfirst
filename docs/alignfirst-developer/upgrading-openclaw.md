---
title: Upgrading OpenClaw
summary: Procedure for moving the test harness, the docs and the deployment template to a new OpenClaw release.
read_when:
  - upgrading OpenClaw to a new release
  - refreshing the read-only clone in .local/openclaw
  - checking an OpenClaw release for behavior changes that affect AlignFirst
---

# Upgrading OpenClaw

## Refresh the read-only clone

`.local/openclaw/` is a shallow clone of the upstream repository, kept for verifying source claims ([openclaw-context-engineering.md](./openclaw-context-engineering.md)). Move it to the new tag:

```sh
git -C .local/openclaw fetch --quiet --depth=1 origin tag v<version>
git -C .local/openclaw switch --quiet --detach v<version>
```

Keep `--quiet` on both commands: errors still print, and without it the fetch of this large repository floods the transcript with progress output. Tags fetched earlier stay available, so two-tag diffs work.

If the clone is missing:

```sh
git clone --quiet --depth=1 --branch v<version> https://github.com/openclaw/openclaw.git .local/openclaw
```

## Review the upstream changes

- Read the new release's section of the clone's `CHANGELOG.md` — top section only, the file is enormous.
- Diff the surfaces our documentation describes: `git -C .local/openclaw diff v<old> v<new> --stat -- src/agents src/commands`, then the files behind any suspicious stat line.
- Re-verify the claims of [openclaw-context-engineering.md](./openclaw-context-engineering.md) against the new tag; the document names its source files. Doctor does not flag silent behavior shifts (the 2026.8 subagent bootstrap narrowing, for example) — only this re-reading catches them.

## Bump the pins

- [`alignfirst-developer-tests/package.json`](../../alignfirst-developer-tests/package.json) — the exact `"openclaw"` pin.
- [`alignfirst-developer-tests/Dockerfile`](../../alignfirst-developer-tests/Dockerfile) — the three `npm:@openclaw/<plugin>@<version>` installs.
- `packages/openclaw-{test,channel-mock-core,discord-mock,slack-mock}/package.json` — `~`-ranged dev dependencies; a patch release needs no edit, a minor one does.

Then rebuild the harness image: `npm run env:build` in `alignfirst-developer-tests/`.

## Run doctor in a throwaway container

Doctor is the upstream migration detector: it flags retired workspace files, retired config keys and pending state migrations. Run it against a scratch copy of the reference workspace — never the original, `--fix` rewrites files:

```sh
cd alignfirst-developer-tests
cp -r workspace /tmp/doctor-workspace
docker run --rm -v /tmp/doctor-workspace:/home/claw/.openclaw/workspace \
  -e ANTHROPIC_API_KEY=x -e OPENROUTER_API_KEY=x -e ZAI_API_KEY=x \
  -e ALIGNFIRST_CODE_AGENT=claude \
  --entrypoint /usr/local/bin/openclaw \
  alignfirst-developer-tests-openclaw-test:latest doctor --json
```

Two findings are expected noise, because no gateway ever runs in this container: the heartbeat cron materialization warning (the gateway reconciles those jobs itself at startup — `reconcileHeartbeatMonitorJobs` in `src/gateway/server-cron.ts`) and the plaintext-secrets warning (the harness injects keys through the environment on purpose). Investigate anything else.

## Run the regression suite

```sh
npm run env:up
npm run e2e -- --channel all --all
npm run env:down
```

## Propagate to the deployment template

When the release retires a config key, the template's seed tolerates it (`set_json_tolerated` in `base/infra/openclaw/seed/common.sh`) — add an entry there. When it retires a workspace file or changes operator-visible behavior, update the setup-guide template docs and, for hardened installations, add a gotcha with the removal procedure (see "Legacy `TOOLS.md`" in the template's `gotchas.md`).
