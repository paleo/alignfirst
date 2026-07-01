// Hook transform for the alcoach coaching-session completion callback.
//
// alcoach POSTs `{ sessionKey, message, idempotencyKey }` to this hook (see
// ALIGNFIRST_COACH_CALLBACK_URL on the gateway service). The built-in `/hooks/agent`
// path defaults to `deliver: true` (announce mode), which forces
// `requireExplicitMessageTarget: true` on the dispatched turn — the agent must
// then supply a canonical `to`, and its natural `message` `thread-reply`
// (channel + threadId, no `to`) is rejected with "Explicit message target
// required for this run".
//
// So we dispatch with `deliver: false` (announce mode "none"). That drops the
// explicit-target requirement, so the resumed session reads the log and reports
// back through its own `message` `thread-reply` into its bound thread — the
// completion lands in the originating thread, the intended flow. No case-variant
// routing: the reply surfaces in the same conversation the work happened in.
export default function codingCallback(ctx) {
  const payload = ctx?.payload || {};
  const sessionKey = typeof payload.sessionKey === "string" ? payload.sessionKey : "";
  const message = typeof payload.message === "string" ? payload.message : "";
  return { kind: "agent", message, sessionKey, deliver: false };
}
