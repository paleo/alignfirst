---
title: AlignFirst Developer OpenClaw Plugin
summary: What the plugin is for, the principles that bound its design, and the approaches tried and dropped.
read_when:
  - changing how a working thread gets started
  - tempted to add a wake, a heartbeat hook or a completion mechanism to the plugin
  - deciding what the bot may promise in a channel or a thread
  - wondering why an OpenClaw entry point is not used
---

# AlignFirst Developer OpenClaw Plugin

`@paleo/alignfirst-developer-openclaw-plugin` (plugin ID `alignfirst-developer`) is the OpenClaw gateway plugin of AlignFirst Developer. This document states what it is for and the principles that bound its design. The [package README](../../packages/alignfirst-developer-openclaw-plugin/README.md) holds the contract and the operations; [`alignfirst-developer.md`](./alignfirst-developer.md) maps the product.

## The one problem it solves

Project work happens in a Slack or Discord thread. The channel session opens the thread and posts the starter, then its turn ends. OpenClaw creates a thread session only when a message arrives in the thread, so the fresh thread stays silent until someone posts there. Without the plugin, a human has to post a message in the thread to start it.

The plugin replaces that human nudge. It does nothing else.

## Principles

### Reproduce the human nudge, with a simple static message

The plugin posts one message into the thread session, the way a human would: `Take over this thread.`, from `AlignFirst Service`. The body is static. It carries no copy of the starter, no routing fields, no handoff ID, no instructions.

The message enters OpenClaw through the same inbound path as a human message. The thread session therefore gets a regular turn: the regular agent budget, the regular tools, the regular delivery to its thread.

Everything that follows belongs to the playbook: the claim, the thread-history read, the wait for a value the starter asked for, the delegation. The nudge supplies no missing value and no approval.

### No heartbeat wake

The heartbeat is OpenClaw's periodic poll, and a heartbeat turn has limited rights: a 600-second budget, no message-action capability, and a scheduler that skips it while another turn runs. The plugin does not use it to start a thread session: no system event, no heartbeat request, no dependency on the heartbeat prompt. Plugin 0.2.0 started threads that way; that design is retired.

### No hack around OpenClaw's handling of long commands

`alcode` runs are long, and other commands are long too. OpenClaw owns how a background `exec` completes and how the agent learns about it. The plugin adds nothing there: no gateway method to start a turn after a command, no command to chain onto a run, no rule about the native completion notice. The delegation guide uses OpenClaw's own means for that, and the plugin stays out of it.

### Say only what is true

The bot claims only what it does. The channel session posts the starter, calls `thread_handoff start` and ends its turn. Its last line never says that this session handles the work or that the work has begun: it has left the thread, and the thread session may still be waiting for a value. In a DM, where the plugin cannot start a thread, the bot says so instead of promising an activation. A completion report relays what the coding agent claims and what the bot verified; it does not call the work done.

## What the plugin does

- It observes successful native `message` actions (`after_tool_call`) and keeps a delivery receipt as evidence that a starter reached a thread. A receipt never triggers anything: an arbitrary thread ID from the model cannot authorize a handoff.
- `thread_handoff start` matches the receipt, records a pending handoff in its SQLite database and posts the nudge on the canonical thread session. A repeated `start` for the same thread returns `alreadyStarted`.
- `thread_handoff claim`, called by the thread session before any task effect, marks the handoff claimed. A repeated claim by the same run returns `claimed` again; another run gets `alreadyClaimed`.
- A recovery scan retries a pending nudge after a gateway restart, at most ten times. A record still pending after that stays claimable by the next human message in the thread.
- `openclaw thread-handoff list | receipts | retire` inspect and maintain the records.

`thread_handoff` is an agent tool the plugin registers itself, marked optional, so a deployment allows it explicitly. The `openclaw thread-handoff` subcommands are plugin CLI registrations. OpenClaw ships neither.

## How the nudge enters OpenClaw

The plugin calls `runtime.channel.inbound.dispatchReply` with a context it builds itself: `SenderName: "AlignFirst Service"`, no sender ID, `WasMentioned: false`, command interpretation suppressed, a distinct `MessageSid` per attempt. Core delivers the turn's final text into the thread through the adapter's `durable` option. Facts established on OpenClaw 2026.9.3, in the deterministic gateway suite:

- The plugin-dispatched turn must disable block streaming. With streaming on, OpenClaw marked the response streamed through a nonposting fallback and dropped the final payload before delivery.
- A silent plugin-dispatched turn ends on `HEARTBEAT_OK`. `NO_REPLY` invoked the isolated finalizer in six probes out of six, on both surfaces, and produced an unsolicited answer.
- A human message posted while the nudge turn runs queues behind it and is processed. This is the property the `agent` gateway method lacked (see below).
- After a gateway restart, core may replay the nudge as a durable user turn while the plugin retries the pending record. The idempotent claim absorbs the duplicate.

Host entry points checked and refused for an external plugin, so the plugin owns its SQLite database and builds the inbound context itself: `openKeyedStore()` (bundled or verified-official plugins only), `api.runtime.gateway.request` (throws for untrusted plugins), `runEmbeddedAgent` (returns payloads without delivering them), `runCommandFromIngress` (for channel plugins with an authenticated sender). A bot's own post never becomes an inbound event, so posting the nudge through the channel API is not an option either.

## Tried and dropped

**Stall detection and keepalive plugin.** A first investigation of ten production stalls on OpenClaw 2026.7.x designed wake detectors and recovery messages. Dropped: the stalls stopped after the upgrade, and the thread-start problem had its own cause.

**Heartbeat wake with a JSON seed** (plugin 0.2.0). `start` queued a replaceable system event carrying the starter and routing in a JSON block, then requested an immediate heartbeat. Three production causes on 2026-09-10 retired it. The heartbeat scheduler skips every wake while the agent's main command lane is busy, so two review requests thirty seconds apart left one thread unstarted until a human wrote in it. The heartbeat budget of 600 seconds aborted a takeover turn mid-setup after the model had polled the background run fifty-five times. And a second `claim` during setup returned `alreadyClaimed`, which the seed read as a duplicate wake, so the turn ended silently without launching anything. The seed text itself needed four wordings of its silence rule, each failing a different way with a different model.

**The `agent` gateway method as the nudge.** The turn it starts is not a channel reply run. A human message posted in the thread during that turn found no run to queue behind, failed OpenClaw's restart-recovery claim and was lost, with zero occurrences of the human text in the transcript across five model runs. The reply-run dispatch above replaced it. The recorded post-mortem: the search had framed the problem as running the agent, when the question was how a message enters a session. The user's frame, replace the human's nudge, was the correct one.

**A plugin gateway method to start the turn after `alcode`** (branch `80/fix-plugin`, removed before merge). The delegation guide chained `openclaw thread-handoff wake --session-key … --message …` onto every run, blocking until the completion turn ended, and the playbook gained rules to answer OpenClaw's own completion notice with `HEARTBEAT_OK`. Dropped by the principle above: it put the plugin in charge of a completion path OpenClaw already owns, and the same path would be needed for every other long command. The evidence recorded against the stock chained `openclaw system event --mode now` is thin: three missing exec-exit wakes among ten stalls on 2026.7.x, whose cooldown explanation was never confirmed, and the 600-second budget, observed on a takeover turn rather than on a completion turn. The chained system event works in practice.

**Intercepting the native exec-completion heartbeat** through the `reply_dispatch` hook. Investigated on the same branch and not implemented: the hook cannot tell from the turn source alone whether the completion was already reported, and registering it disables OpenClaw's restart recovery.

## Open observations

- With `claude-sonnet-5`, the bot ran ninety-six `alcode` executions in one test day in the foreground with a 60-second timeout, ignoring the background rule. Terra ran none. The 30-second mock run hides the harm a real coding agent would suffer.
- Terra chains one background run per completion step (code, log review, tests, push), so the user sees several intermediate acknowledgements. A product question, not a defect.
- A `⚠️ Message blocked` host notice appeared twice in Slack threads after a silent takeover turn. Its text is in neither the OpenClaw sources nor the build.
- The first visible thread post lands 1.5 to 2.5 minutes after the starter, at the end of the setup turn. The user sees nothing meanwhile.
