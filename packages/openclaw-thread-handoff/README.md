# @paleo/openclaw-thread-handoff

An OpenClaw gateway plugin that starts a regular channel-thread session after a native message
action has delivered its visible starter. Delivery evidence and pending handoffs survive gateway
restart in a plugin-owned SQLite database.

## Install and enable

Install the package through OpenClaw's normal external-plugin procedure, enable plugin ID
`thread-handoff`, and explicitly allow the optional `thread_handoff` tool:

```json
{
  "plugins": {
    "allow": ["thread-handoff"],
    "entries": { "thread-handoff": { "enabled": true } }
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
      "thread-handoff": {
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

## Contract

The plugin observes successful native `message` actions but never creates a thread itself.

- Slack evidence is a successful `send` to the current parent channel with an explicit `threadId`,
  nonempty body, and confirmed message ID.
- Discord evidence is a successful anchored `thread-create` in the current parent channel with a
  nonempty starter and returned thread ID. A partial result is rejected.
- `thread_handoff { "action": "start", "threadId": "..." }` returns `queued` or
  `alreadyStarted`, plus the opaque handoff ID and canonical target session key.
- `thread_handoff { "action": "claim", "handoffId": "..." }` returns `claimed`,
  `alreadyClaimed`, or `none`. The ID is optional for an ordinary human turn in the target thread.

Inputs are strict. Errors begin with a stable reason code: `unsupportedContext`,
`unverifiedThreadDelivery`, `conflictingHandoff`, `invalidTarget`, or
`unavailablePersistentState`. A capacity failure preserves `STORE_LIMIT_EXCEEDED` as its cause.

Starts are limited to distinct regular parent-channel sessions. DMs, group DMs, Slack Agent View,
ACP, subagent, cron, global/shared, already-threaded, and ambiguous cross-account routes are not
supported.

## Wake and persistence

Before requesting a wake, the plugin commits a pending record and queues one replaceable system
event for the canonical thread session. The event tells the receiver to load its playbook and claim
the explicit handoff before task effects. The exact starter is serialized inside a JSON user-content
block; it is not plugin instruction text.

The database is `<stateDir>/thread-handoff/state.sqlite`, where `stateDir` comes from
`api.runtime.state.resolveStateDir()`. It uses WAL, full synchronous durability, a `0700` directory,
and a `0600` database file. Receipts expire after one hour and are capped at 10,000 active entries.
Handoffs have a separate 10,000-record cap and do not expire automatically. Pending records are
retried at startup and every 30 seconds. Claimed records remain as duplicate-start protection;
native OpenClaw recovery, not this plugin, owns interrupted work after claim.

Use `openclaw thread-handoff list [--json]` to inspect records and
`openclaw thread-handoff retire <handoff-id>` to remove a claimed record. Pending records cannot be
retired.

For a backup, stop the gateway and let the plugin close/checkpoint its connection, then copy the
database together with any WAL/SHM crash-state files; alternatively use a SQLite-consistent backup.
Do not copy only the main file from a live gateway. Retain pending work. Retire only finished managed
handoffs, because deleting a claimed record also deletes its duplicate-start protection.

## Development

```bash
npm run build --workspace @paleo/openclaw-thread-handoff
npm test --workspace @paleo/openclaw-thread-handoff
npm run typecheck --workspace @paleo/openclaw-thread-handoff
npm run lint --workspace @paleo/openclaw-thread-handoff
```
