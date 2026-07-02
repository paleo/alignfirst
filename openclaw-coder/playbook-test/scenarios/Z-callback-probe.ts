import type { BusMessage, ScenarioContext } from "@paleo/openclaw-test";

// THROWAWAY understanding probe (delete after use). Goal: isolate OpenClaw's `/hooks` callback
// DELIVERY behavior, free of the coaching playbook's thread/worktree machinery.
//
// We (1) establish the channel session with a trivial inbound and let the main turn finish (so the
// session lane is free), then (2) fire a callback at `/hooks/coding` exactly like alcoach's detached
// child does — the mapped transform dispatches an ISOLATED agent turn with `deliver: true` +
// `to: channel:<room>`. We then (3) observe every outbound and report WHERE the resumed turn's reply
// lands: conversation id (and its case vs ours), and whether it carries a threadId.
//
// The probe message forces a fixed trivial reply and forbids threads/tools, so what we measure is the
// delivery mechanism, not the agent's cognition.
const PROBE_TOKEN = "PROBEOK-Z1";

export default async function callbackProbe(ctx: ScenarioContext): Promise<void> {
  ctx.log(`channel=${ctx.channel} conversationId=${ctx.conversationId}`);

  // 1) Establish the channel session; wait for the agent's reply so the main turn releases the lane.
  const startCursor = await ctx.getCursor();
  await ctx.sendInbound({ senderId: "ROBIN01", senderName: "ROBIN01", text: "ping" });
  const firstReply = await ctx.waitForOutbound((m) => m.direction === "outbound", {
    timeoutMs: 90_000,
    sinceCursor: startCursor,
  });
  ctx.log(`first reply: ${describe(firstReply.match)}`);

  // 2) Resume the REAL channel session via the gateway RPC (the Option-A mechanism), instead of the
  //    isolated /hooks/agent path. Room = lowercased conversation id (how the channel session key
  //    encodes it: agent:main:<channel>:channel:channel:<room>). The message probes BOTH delivery and
  //    context: if the reply recalls the earlier "ping", the session was resumed WITH its transcript.
  const room = ctx.conversationId.toLowerCase();
  const sessionKey = `agent:main:${ctx.channel}:channel:channel:${room}`;
  ctx.log(`resuming via gateway → sessionKey=${sessionKey}`);
  const fireCursor = await ctx.getCursor();
  const params = JSON.stringify({
    sessionKey,
    message:
      `A background task (ref ${PROBE_TOKEN}) you started earlier just finished. Use the message tool ` +
      `to post a short note to the user in THIS conversation telling them it is done, including the ` +
      `ref ${PROBE_TOKEN}.`,
    idempotencyKey: "probe-z1",
  });
  const openclawBin = "/opt/openclaw-test/src/node_modules/.bin/openclaw";
  const rpc = await ctx.execInGateway(
    [openclawBin, "gateway", "call", "chat.send", "--params", params, "--token", "x", "--expect-final"],
    { timeoutMs: 30_000 },
  );
  ctx.log(`chat.send: exit=${rpc.exitCode} stdout=${rpc.stdout.trim().slice(0, 300)} stderr=${rpc.stderr.trim().slice(0, 300)}`);

  // 3) Observe everything for 90s and report where the reply lands.
  const deadline = Date.now() + 90_000;
  let cursor = fireCursor;
  let landed = false;
  while (Date.now() < deadline) {
    const batch = await ctx.poll({ sinceCursor: cursor, timeoutMs: 8_000 });
    cursor = batch.nextCursor;
    for (const m of batch.messages) {
      if (m.direction !== "outbound") continue;
      ctx.log(`outbound after callback: ${describe(m)}`);
      if (m.text.includes(PROBE_TOKEN)) {
        landed = true;
        ctx.log(
          `>>> PROBE REPLY LANDED. conv=${m.conversation.id} ` +
            `exactCase=${m.conversation.id === ctx.conversationId} ` +
            `lowerMatch=${m.conversation.id === room} thread=${m.threadId ?? "none"}`,
        );
      }
    }
    if (landed) break;
  }
  if (!landed) ctx.log(">>> PROBE REPLY did NOT land within 90s (no outbound carried the token).");

  // Diagnostics: did the dispatched isolated turn run at all? (cron jobs, trajectory files, log tail).
  await dumpGateway(ctx, "cron jobs", ["sh", "-c", "cat /home/claw/.openclaw/cron/jobs.json 2>/dev/null | head -c 2000"]);
  await dumpGateway(ctx, "trajectory files", ["sh", "-c", "ls -t /home/claw/.openclaw/logs/trajectory/ 2>/dev/null | head"]);
  await dumpGateway(ctx, "sessions", ["sh", "-c", "ls -t /home/claw/.openclaw/agents/main/sessions/ 2>/dev/null | head"]);
  await dumpGateway(ctx, "log tail (hook/cron/announce/deliver/error after fire)", [
    "sh",
    "-c",
    "grep -iE 'hook|cron|announce|deliver|isolated|error|warn|target|" +
      room +
      "' /tmp/openclaw/openclaw-2026-07-01.log 2>/dev/null | tail -40 | " +
      "sed -E 's/.*\"message\":\"([^\"]*)\".*/\\1/'",
  ]);

  ctx.markScenarioAsEnded("PASS");
  ctx.log("PROBE DONE");
}

async function dumpGateway(ctx: ScenarioContext, label: string, argv: string[]): Promise<void> {
  const r = await ctx.execInGateway(argv, { timeoutMs: 15_000 });
  ctx.log(`[${label}] exit=${r.exitCode}\n${(r.stdout || r.stderr).trim().slice(0, 1500)}`);
}

function describe(m: BusMessage): string {
  const text = m.text.replace(/\s+/g, " ").slice(0, 80);
  return `conv=${m.conversation.id} thread=${m.threadId ?? "none"} text=${JSON.stringify(text)}`;
}
