---
title: Manual Gateway Sandbox
summary: Start the test gateway and probe thread handoff without the scenario runner.
read_when:
  - probing the plugin or a playbook change by hand outside the scenario runner
---

# Manual Gateway Sandbox

## Start the stack

From `alignfirst-developer-tests/`:

```sh
npm run env:up
docker compose -p alignfirst-developer-tests-w1 exec gateway bash
```

The worker-one project is `<consumer-directory>-w1`; here it is `alignfirst-developer-tests-w1`. The stack publishes no host ports. Run bus requests inside its network at `http://bus:43123`.

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

## Probe the gateway

Run these inside the gateway container:

```sh
openclaw thread-handoff list --json
openclaw thread-handoff receipts --json
openclaw thread-handoff wake --session-key <key> --message '<message>'
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

The `transcript_events` columns are `session_id`, `seq`, `event_json`, and `created_at` in OpenClaw 2026.9.3. Confirm them after an upgrade with `.schema transcript_events`.

The `thread-handoff wake` command dispatches the plugin's reply run and serves as the alcode completion wake. `gateway call agent --expect-final` and `openclaw agent --session-key` start regular turns through the `agent` method; they remain useful generic probes.

The `system event` command uses the heartbeat-gated gateway `wake` RPC. It is a diagnostic probe, not the thread-start mechanism or an equivalent of a native exec completion.

A takeover uses the exact body `Take over this thread.`; the plugin supplies `AlignFirst Service` as sender context. Inspect provider payloads when diagnosing heartbeat prompts, because saved transcripts replace their user message with a marker.

For deeper traces, set the gateway variables documented in [OpenClaw Context Engineering](./openclaw-context-engineering.md#debugging-see-what-the-model-actually-receives): `OPENCLAW_ANTHROPIC_PAYLOAD_LOG`, `OPENCLAW_RAW_STREAM`, `OPENCLAW_CACHE_TRACE`, and `OPENCLAW_DEBUG_MODEL_PAYLOAD`.

A real-Slack sandbox using `@openclaw/slack`, a test workspace, and a test app is the only way to observe the channel itself. It is a candidate for a later plan.
