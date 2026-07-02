// Hook transform for the alcoach coaching-session completion callback.
//
// alcoach POSTs `{ sessionKey, message, idempotencyKey }` to this hook (see
// ALIGNFIRST_COACH_CALLBACK_URL on the gateway service). OpenClaw dispatches the
// resumed turn as an ISOLATED cron turn: `/hooks/agent` forces a fresh session
// (`sessionTarget: "isolated"` → `forceNew`), so the turn has NO prior transcript
// — only this `message` and the `sessionKey`. It therefore cannot know the
// threadId the launching turn created, and cannot thread-reply into it.
//
// So we deliver via ANNOUNCE with an explicit target computed here from the
// session key. `deliver: true` alone can't auto-resolve a channel (two mock
// channels are configured, and the target session records no `lastChannel` — the
// playbook posts via `thread-create`/`thread-reply`, which, unlike `send`, don't
// set the delivery mirror). By parsing `agent:main:<channel>:…:<room>` we set the
// channel + `to: channel:<room>` ourselves, satisfying announce mode's explicit-
// target requirement. The turn's report is then announced into that channel
// conversation — the reliable surface for an isolated resume. OpenClaw lowercases
// the room in the session key, so the completion lands under a case-variant
// conversation id; the scenario matches case-insensitively.
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
