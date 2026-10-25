---
title: Manual Gateway Sandbox
summary: Start the test gateway, probe thread handoff and drive an app conversation without the scenario runner.
read_when:
  - probing the plugin or a playbook change by hand outside the scenario runner
---

# Manual Gateway Sandbox

## Start the stack

From `aligndev-openclaw-tests/`:

```sh
npm run env:up
docker compose -p aligndev-openclaw-tests-w1 exec gateway bash
```

The worker-one project is `<consumer-directory>-w1`; here it is `aligndev-openclaw-tests-w1`. The stack publishes no host ports. Run bus requests inside its network at `http://bus:43123`.

## Inject and inspect a message

Inside the gateway container:

```sh
curl -sS -X POST -H 'content-type: application/json' \
  --data '{
    "accountId": "<channel id>",
    "conversation": {
      "kind": "channel",
      "id": "<conversation id>",
      "title": "<title>"
    },
    "senderId": "<id>",
    "senderName": "<name>",
    "text": "<text>",
    "threadId": "<optional>"
  }' \
  http://bus:43123/v1/inbound/message

curl -sS http://bus:43123/v1/state
```

From the host, the helper supplies the test sender `ROBIN01` and runs the same request through Compose:

```sh
sandbox/inbound.sh <channel> <conversation-id> <text> [thread-id]
```

Keep notes and captured payloads under `.local/side-7/`.

## Drive a conversation

An app conversation needs no bus: run the gateway methods the apps use, inside the gateway container.

```sh
# Home is agent:main:main. Without cwd, a conversation runs on the agent workspace.
openclaw gateway call sessions.create --params '{"label":"probe"}' --json
# On a project folder, with a managed worktree on branch openclaw/<name>:
openclaw gateway call sessions.create \
  --params '{"label":"probe","cwd":"/home/assistant/projects/nimbus","worktree":true,"worktreeName":"probe"}' --json

openclaw gateway call chat.send \
  --params '{"sessionKey":"<key>","message":"<text>","idempotencyKey":"<uuid>"}' --json
openclaw gateway call chat.history --params '{"sessionKey":"<key>","limit":50}' --json

openclaw gateway call sessions.reset --params '{"key":"agent:main:main"}' --json
openclaw gateway call sessions.patch \
  --params '{"key":"<key>","archived":true,"expectedSessionId":"<sessionId>"}' --json
openclaw worktrees list --json
```

`sessions.create` returns the session `key`, and with a worktree the checkout's `worktree.path` and `worktree.branch`. A `cwd` outside the agent workspaces needs `operator.admin`: the CLI retries with that scope after a `FORBIDDEN` line in the gateway log. `chat.send` returns at run start; its `runId` is the `idempotencyKey`, a fresh one per message. A reply is an assistant message of `chat.history` with `stopReason: "stop"`; the run is over when the response has no `inFlightRun`. [OpenClaw Context Engineering](./openclaw-context-engineering.md#gateway-contract) records the full response shapes.

## Probe the gateway

Run these inside the gateway container:

```sh
openclaw thread-handoff list --json
openclaw thread-handoff receipts --json
openclaw system event --session-key <key> --mode now --text '<event>'
openclaw gateway call agent --params '{"sessionKey":"<key>","message":"<message>","deliver":true,"replyChannel":"<channel>","replyTo":"<target>","replyAccountId":"<account>","threadId":"<thread>","timeout":<seconds>}' --expect-final
openclaw agent --session-key <key> --deliver --timeout 0 --message '<message>'

sqlite3 -readonly ~/.openclaw/thread-handoff/state.sqlite \
  "select count(*) from receipts; select count(*) from handoffs;"
sqlite3 -readonly ~/.openclaw/agents/main/agent/openclaw-agent.sqlite \
  "select json_extract(event_json,'\$.message.details') from transcript_events
   where json_extract(event_json,'\$.message.toolName')='message'
   order by created_at desc limit 1;"
```

Since OpenClaw 2026.9.6, `transcript_events` stores an event of 1 KiB or more zstd-compressed in `event_zstd`, with `event_json` NULL. The query above sees only smaller events; decompress `event_zstd` with `node:zlib` for the others, as the harness readers do. Confirm the columns after an upgrade with `.schema transcript_events`.

`gateway call agent --expect-final` and `openclaw agent --session-key` start regular turns through the `agent` method; they remain useful generic probes.

The `system event` command uses the heartbeat-gated gateway `wake` RPC. It is the guide's `aligndev code` completion path and a useful probe. It is distinct from the thread-start mechanism and OpenClaw's native exec completion.

A takeover uses the exact body `Take over this thread.`; the plugin supplies `AlignFirst Service` as sender context. Inspect provider payloads when diagnosing heartbeat prompts, because saved transcripts replace their user message with a marker.

For deeper traces, set the gateway variables documented in [OpenClaw Context Engineering](./openclaw-context-engineering.md#debugging-see-what-the-model-actually-receives): `OPENCLAW_ANTHROPIC_PAYLOAD_LOG`, `OPENCLAW_RAW_STREAM`, `OPENCLAW_CACHE_TRACE`, and `OPENCLAW_DEBUG_MODEL_PAYLOAD`.

A real-Slack sandbox using `@openclaw/slack`, a test workspace, and a test app is the only way to observe the channel itself. It is a candidate for a later plan.
