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
- Compare the deployment template's workspace files (`skills/alignfirst-setup-guide/assets/alignfirst-dev-kit-template/base/infra/openclaw/workspace/`) with `WORKSPACE_BOOTSTRAP_FILENAMES` in `src/agents/workspace.ts`. A file the runtime stopped reading must leave the template and its `chattr` lists; 2026.8.1 retired `HEARTBEAT.md` this way and the check above did not catch it.
- Diff the config help between the tags: `git -C .local/openclaw diff v<old> v<new> -- 'src/config/schema.help.*.ts'`. A default that turns on a background behavior (a scheduled model run, a memory feature, a telemetry ping) appears there and nowhere doctor looks; see [Propagate](#propagate-to-the-deployment-template).
- Recheck the public plugin tool/hook context, routing helpers, state-root resolver, and session-binding APIs required by `@alignfirst/service-openclaw-plugin`. Load it from an ordinary external path; an allowlist is not an official-plugin trust grant.
- Recheck `PluginRuntimeChannel.inbound.dispatchReply` in `src/plugins/runtime/types-channel.ts` and the `AssembledChannelTurn` delivery adapter's `durable` option in `src/channels/turn/types.ts` and `durable-delivery.ts`, including `to`, `threadId`, and `replyToId` resolution. Also recheck `reply.finalizeInboundContext`, `session.recordInboundSession`, the core gateway `wake` method used by `openclaw system event`, and the heartbeat exec-completion prompt.
- Recheck `HEARTBEAT_OK` on heartbeat turns and plugin-dispatched reply runs. Use the deterministic gateway suite as the judge.
- Recheck the credential import and version-specific build repair described in [Running the OpenClaw Tests](./running-openclaw-tests.md#configuration). Remove a workaround only after the subscription-backed Terra scenario passes without it.

## Bump the pins

- [`alignfirst-dev-kit-tests/package.json`](../../alignfirst-dev-kit-tests/package.json) — the exact `"openclaw"` pin.
- [`alignfirst-dev-kit-tests/Dockerfile`](../../alignfirst-dev-kit-tests/Dockerfile) — the three `npm:@openclaw/<plugin>@<version>` installs.
- `packages/openclaw-{test,channel-mock-core,discord-mock,slack-mock}/package.json` and `packages/service-openclaw-plugin/package.json` — `~`-ranged dev dependencies; a patch release needs no edit, a minor one does.

Then rebuild the harness image: `npm run env:build` in `alignfirst-dev-kit-tests/`.

Before model-driven scenarios, run the harness's deterministic handoff checks against the new host:
confirmed native receipt, trusted tool context, exact canonical thread delivery, reply-run session
start, pending restart recovery, and the human-message-before-takeover race. A successful plugin import alone
does not establish these combined contracts.

Keep the first-attempt assertion on the immediate reply dispatch. It must start and claim the target session before recovery spacing elapses. This catches dispatches that inherit a closed asynchronous work scope from the calling tool turn.

## Run doctor in a throwaway container

Doctor is the upstream migration detector: it flags retired workspace files, retired config keys and pending state migrations. Run it against scratch copies of both workspaces we ship, the harness reference and the deployment template (base files plus one surface's `AGENTS.md`) — never the originals, `--fix` rewrites files:

```sh
cd alignfirst-dev-kit-tests
template=../skills/alignfirst-setup-guide/assets/alignfirst-dev-kit-template
cp -r workspace /tmp/doctor-harness
cp -r $template/base/infra/openclaw/workspace /tmp/doctor-template
cp $template/variants/surfaces/slack/infra/openclaw/workspace/AGENTS.md /tmp/doctor-template/
for ws in /tmp/doctor-harness /tmp/doctor-template; do
  docker run --rm -v $ws:/home/assistant/.openclaw/workspace \
    -e ANTHROPIC_API_KEY=x -e OPENROUTER_API_KEY=x -e ZAI_API_KEY=x \
    -e ALIGNFIRST_CODE_AGENT=claude \
    --entrypoint /usr/local/bin/openclaw \
    alignfirst-dev-kit-tests-openclaw-test:latest doctor --json
done
```

Four findings are expected noise, because no gateway ever runs in this container: the heartbeat cron materialization warning (the gateway reconciles those jobs itself at startup — `reconcileHeartbeatMonitorJobs` in `src/gateway/server-cron.ts`), the plaintext-secrets warning (the harness injects keys through the environment on purpose), and the node-hosting preconditions about the loopback bind and disabled device pairing. Investigate anything else.

## Inspect a running gateway

`env:up` starts the worker gateways with the harness config. Ask one which jobs and plugins the release materialized on its own:

```sh
npm run env:up
docker exec alignfirst-dev-kit-tests-w1-gateway-1 openclaw cron list --all
docker exec alignfirst-dev-kit-tests-w1-gateway-1 openclaw plugins list
```

Expected: `heartbeat:main` as the only enabled job (the skill-collection review may be listed as disabled), and no plugin outside `openclaw.json`. A new enabled job or an unlisted plugin is a default the release turned on; find its knob in the config help diff.

## Run the regression suite

```sh
npm run e2e -- --channel all --all
npm run env:down
```

## Propagate to the deployment template

The seed targets the current release. When the release retires a config key the seed sets, delete or replace the line. When it retires a workspace file or changes operator-visible behavior, update the setup-guide template: it describes a fresh install on the current release, so retired files and keys leave it, and the consumers' own runbooks carry the migration. When it turns on a background behavior, add the opt-out to `base/infra/openclaw/seed/common.sh` and to `alignfirst-dev-kit-tests/openclaw.json`, which carry the same opt-outs. Bump the `version` in the skill's `SKILL.md`.

Every other changed default stays out of the seed. The rendered repository states the rule in [`docs/configuration.md`](../../skills/alignfirst-setup-guide/assets/alignfirst-dev-kit-template/base/docs/configuration.md): a pin needs a stated policy, and preserving previous behavior is not one. The background opt-outs above hold their policies — no autonomous model spend, no telemetry ping.
