# @paleo/alignfirst-developer-openclaw-plugin

The OpenClaw gateway plugin for AlignFirst Developer. It currently provides thread handoff: after a native message action delivers its visible starter, the plugin starts the regular channel-thread session through a reply run it dispatches itself. Delivery evidence and pending handoffs survive gateway restart in a plugin-owned SQLite database.

## Install and enable

Install the package through OpenClaw's normal external-plugin procedure, enable plugin ID
`alignfirst-developer`, and explicitly allow the optional `thread_handoff` tool:

```json
{
  "plugins": {
    "allow": ["alignfirst-developer"],
    "entries": { "alignfirst-developer": { "enabled": true } }
  },
  "tools": { "allow": ["thread_handoff"] }
}
```

The built-in channel mapping is Slack and Discord. Synthetic or renamed channel plugins can map
their IDs to the corresponding native contract:

```json
{
  "plugins": {
    "entries": {
      "alignfirst-developer": {
        "enabled": true,
        "config": {
          "channelSurfaces": {
            "slack-mock": "slack",
            "discord-mock": "discord"
          }
        }
      }
    }
  }
}
```

## Thread handoff contract

The plugin observes successful native `message` actions but never creates a thread itself.

- Slack evidence is a `send` to the current parent channel with an explicit `threadId`, nonempty body, `deliveryStatus: "sent"`, and `messageDelivery: { status: "settled", partialDelivery: false }`. The result must include a channel-kind `target` naming the parent and a nonempty `messageId`; `result.receipt.threadId`, when present, must match the requested thread. The plugin-path `{ ok, result }` shape used by team-qualified Slack sends is rejected.
- Discord evidence is a successful anchored `thread-create` in the current parent channel with a
  nonempty starter and returned thread ID. A partial result is rejected.
- `thread_handoff { "action": "start", "threadId": "..." }` returns `queued` or
  `alreadyStarted`, plus the opaque handoff ID and canonical target session key.

The claim result has this contract:

| Status | Meaning |
| --- | --- |
| `claimed` | The first claim, or a repeated claim by the same run. |
| `alreadyClaimed` | Another run owns the handoff. The result includes `claimedAt`. |
| `none` | No handoff matches an ordinary human turn in the target thread. |

The receiving turn calls `thread_handoff { "action": "claim" }` once before task effects. The tool resolves the handoff from the current thread session; an explicit handoff ID remains an optional API parameter.

Inputs are strict. Errors begin with a stable reason code: `unsupportedContext`,
`unverifiedThreadDelivery`, `conflictingHandoff`, `invalidTarget`, or
`unavailablePersistentState`. A capacity failure preserves `STORE_LIMIT_EXCEEDED` as its cause.
Rejected eligible delivery observations emit one debug line with `notSent`, `partialDelivery`, `channelMismatch`, `threadMismatch`, `missingMessageId`, `missingThread`, `missingStarter`, or `accountMismatch`. The line contains no starter text or result payload.

Starts are limited to distinct regular parent-channel sessions. DMs, group DMs, Slack Agent View,
ACP, subagent, cron, global/shared, already-threaded, and ambiguous cross-account routes are not
supported.

## Turn start and persistence

The plugin commits a pending record before dispatching `Take over this thread.` from `AlignFirst Service` as a reply run through the
channel-inbound path. Its plugin-built context sets the service display name without a human sender ID or command authority, and sets
`WasMentioned: false`. These plugin-dispatched turns disable block streaming so their complete
final payload reaches OpenClaw's durable outbound path. The reply run records the session's last
route. The plugin's in-process nudge does not need an `openclaw` executable on the gateway's `PATH`.

The message body is static: it carries no starter copy, routing fields, or handoff ID. The playbook routes by thread metadata, claims the current session, and reads the visible starter and human replies through thread history. The nudge supplies no missing input or approval. A takeover turn with nothing to report ends with `HEARTBEAT_OK`; the deterministic gateway probe confirmed that `NO_REPLY` still triggers isolated finalization on this path.

The plugin starts the thread session and does nothing after that. Alcode completion uses OpenClaw's own completion path.

Each takeover turn gets the regular agent budget from `agents.defaults.timeoutSeconds`, including the 48-hour OpenClaw default and the unlimited `0` value.

The database is `<stateDir>/thread-handoff/state.sqlite`, where `stateDir` comes from
`api.runtime.state.resolveStateDir()`. It uses WAL, full synchronous durability, a `0700` directory,
and a `0600` database file. Receipts expire after one hour and are capped at 10,000 active entries.
Handoffs have a separate 10,000-record cap and do not expire automatically. The plugin scans
pending records at startup and every 30 seconds. It starts at most ten attempts, with at least 60
seconds after an attempt ends before the next one. A record still pending after the tenth attempt
stays claimable by the next human message in the thread. Claimed records remain as duplicate-start
protection; native OpenClaw recovery owns interrupted work after claim.

Use `openclaw thread-handoff list [--json]` to inspect handoffs with their attempt counts and
claimer identity. Use `openclaw thread-handoff receipts [--json]` to inspect active delivery
receipts without starter text. `openclaw thread-handoff retire <handoff-id>` removes a claimed
record; add `--force` for a pending record, typically a parked one.

Opening a database created by plugin 0.2.0 migrates it automatically to schema 2. The migration
preserves pending attempt history and claimed records. To downgrade to 0.2.0, stop the gateway and delete `<stateDir>/thread-handoff/state.sqlite`. Deletion loses pending handoffs.

For a backup, stop the gateway and let the plugin close/checkpoint its connection, then copy the
database together with any WAL/SHM crash-state files; alternatively use a SQLite-consistent backup.
Do not copy only the main file from a live gateway. Retain pending work. Retire only finished managed
handoffs, because deleting a claimed record also deletes its duplicate-start protection.

## Development

`src/index.ts` defines the plugin identity and configuration schema. `src/thread-handoff/` owns handoff registration, tools, hooks, recovery and persistence. Additional Developer features can register alongside it through the root entry point.

```bash
npm run build --workspace @paleo/alignfirst-developer-openclaw-plugin
npm test --workspace @paleo/alignfirst-developer-openclaw-plugin
npm run typecheck --workspace @paleo/alignfirst-developer-openclaw-plugin
npm run lint --workspace @paleo/alignfirst-developer-openclaw-plugin
```

The ordinary test command excludes the real-gateway suite. To exercise the package as an external
plugin against the pinned OpenClaw 2026.9.3 runtime, including Slack/Discord delivery, concurrent human messages, duplicate starts, same-session continuation, and abrupt restart recovery:

```bash
KEEP_THREAD_HANDOFF_ARTIFACTS=1 npm run test:integration --workspace @paleo/alignfirst-developer-openclaw-plugin
```

Retained fixtures are written under `/tmp/thread-handoff-*` with gateway logs, provider requests,
plugin SQLite state, configuration, and workspace files. Omit the environment variable for normal
automatic cleanup.
