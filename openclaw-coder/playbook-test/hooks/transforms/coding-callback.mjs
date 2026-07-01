// Hook transform for the alcoach coaching-session completion callback.
//
// alcoach POSTs `{ sessionKey, message, idempotencyKey }` to this hook (see
// ALIGNFIRST_COACH_CALLBACK_URL on the gateway service). The built-in `/hooks/agent`
// path defaults to `deliver: true` (announce mode), which requires an explicit
// delivery channel + target. In this harness neither resolves automatically:
// two channels (discord-mock, slack-mock) are configured, and the target
// session has no recorded `lastChannel`/target (the playbook posts via the
// `message` tool's `thread-create` / `thread-reply` plugin actions, which —
// unlike `send` — do not set the delivery mirror).
//
// So we dispatch the agent turn with `deliver: false`: the resumed session reads
// the log and reports back to the user through its own `message` tool call
// (thread-reply into the originating thread), which is the intended flow. We
// still derive the channel from the session key (`agent:main:<channel>:…`) as a
// harmless hint for any downstream resolution.
const KNOWN_CHANNELS = new Set(["discord-mock", "slack-mock"]);

export default function codingCallback(ctx) {
  const payload = ctx?.payload || {};
  const sessionKey = typeof payload.sessionKey === "string" ? payload.sessionKey : "";
  const message = typeof payload.message === "string" ? payload.message : "";
  const override = { kind: "agent", message, sessionKey, deliver: true };
  const route = routeFromSessionKey(sessionKey);
  if (route) {
    override.channel = route.channel;
    override.to = `channel:${route.room}`;
  }
  return override;
}

// `agent:main:<channel>:channel:channel:<room>` or `agent:main:<channel>:thread:<room>`.
function routeFromSessionKey(sessionKey) {
  const parts = sessionKey.split(":");
  const channel = parts[2];
  const room = parts[parts.length - 1];
  if (!KNOWN_CHANNELS.has(channel) || !room) return undefined;
  return { channel, room };
}
