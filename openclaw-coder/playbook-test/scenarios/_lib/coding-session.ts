import type { ScenarioContext } from "@paleo/openclaw-test";

// The "started in the background" ack reliably carries one of these markers (the alcode guide
// tells the agent it launched a background run and will report back). Kept off `en cours`, which
// also appears in some `[WORK]` headers.
export const STARTED_ACK_RE =
  /background|arri[èe]re-plan|pr[ée]vien|tiens au courant|reviens|informe/i;

// The completion report (after the exec wake) says the work FINISHED. Distinct from STARTED_ACK_RE
// (which promises a future update) so a completion wait can scan from before the ack and still
// match only the completion — avoiding coupling to the ack wait's batch cursor.
export const COMPLETION_RE = /termin[ée]|c'est (fait|bon)|finished|succès|success|done|✅/i;

// Launch/setup wording that must never satisfy a completion or findings wait: a workspace report
// or launch announcement can carry a ✅ ("Bootstrap: ready ✅ | Lancement du coding agent…") with
// no STARTED_ACK_RE marker, so COMPLETION_RE alone would match it.
export const LAUNCH_OR_SETUP_RE = /lancement|je lance|launch|starting|d[ée]marr|bootstrap/i;

/**
 * Poll the gateway for alcode's per-run coding-session file reaching `status: succeeded` — the
 * model-independent proof the delegated session finished, and the ground truth the completion
 * wake rides on. `find` (not a shell glob) so an absent match in any single project dir does not
 * error; alcode writes under `<project>/.plans/<ticket>/coding-sessions/<stamp>.md` (or
 * `.plans/_coding-sessions/` without a ticket), and worktree `.plans` symlinks back to the main
 * project so either path resolves. Returns the matching session file path.
 */
export async function waitForCodingSessionSucceeded(
  ctx: ScenarioContext,
  opts: { ticketId?: string; timeoutMs: number },
): Promise<string> {
  const sessionsDir = opts.ticketId
    ? `.plans/${opts.ticketId}/coding-sessions`
    : ".plans/_coding-sessions";
  const deadline = Date.now() + opts.timeoutMs;
  const findArgs = [
    "find",
    "/home/claw/projects",
    "-path",
    `*/${sessionsDir}/*.md`,
    "-exec",
    "grep",
    "-l",
    "status: succeeded",
    "{}",
    "+",
  ];
  let lastStderr = "";
  while (Date.now() < deadline) {
    const r = await ctx.execInGateway(findArgs, { timeoutMs: 15_000 });
    const hit = r.stdout.trim().split("\n").find(Boolean);
    if (hit) return hit;
    lastStderr = r.stderr.trim();
    await delay(3_000);
  }
  throw new Error(
    `alcode coding-session file under ${sessionsDir} never reached "status: succeeded" ` +
      `within ${opts.timeoutMs}ms${lastStderr ? ` (last stderr: ${lastStderr})` : ""}`,
  );
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
