import type { ScenarioContext } from "@paleo/openclaw-test";

// The "started" ack reliably carries one of these markers: either a promise to report back
// ("je te préviens", "background") or a bare launch announcement ("je lance le travail",
// "launching now") — a terse second delegation in a thread often uses the latter without any
// forward-looking promise (e.g. qwen's "C'est noté — je lance l'ajout de l'infobulle"). Kept off
// `en cours`, which also appears in some `[WORK]` headers. Used to DETECT the ack — not to subtract
// it from a completion match (see FORWARD_LOOKING_ACK_RE for that).
export const STARTED_ACK_RE =
  /background|arri[èe]re-plan|pr[ée]vien|tiens au courant|reviens|informe|je lance|lancement|launch|starting/i;

// The forward-looking subset of STARTED_ACK_RE — "I'll tell you when it's done". A completion wait
// uses THIS (not STARTED_ACK_RE) to exclude the earlier ack: `background`/`arri[èe]re-plan` are not
// tense-bearing, so a legitimate completion like "la tâche en arrière-plan est terminée ✅" would
// otherwise be wrongly subtracted and the wait would time out on a correct run.
export const FORWARD_LOOKING_ACK_RE = /pr[ée]vien|tiens au courant|reviens|d[èe]s que/i;

// The completion report (after the exec wake) says the work FINISHED. Distinct from
// FORWARD_LOOKING_ACK_RE (which promises a future update) so a completion wait can scan from before
// the ack and still match only the completion — avoiding coupling to the ack wait's batch cursor.
export const COMPLETION_RE = /termin[ée]|c'est (fait|bon)|finished|succès|success|done|✅/i;

// Launch/setup wording that must never satisfy a completion or findings wait: a workspace report
// or launch announcement can carry a ✅ ("Bootstrap: ready ✅ | Lancement du coding agent…") with
// no STARTED_ACK_RE marker, so COMPLETION_RE alone would match it.
export const LAUNCH_OR_SETUP_RE = /lancement|je lance|launch|starting|d[ée]marr|bootstrap/i;

// Exclusion regexes identify ANNOUNCEMENTS — short ack / launch / setup lines whose marker sits in
// the opening. A substantive findings or completion report can mention the same wording in a
// closing offer ("…dis-moi le ID et je lance le workflow"), which must not disqualify it: test the
// opening only, never the full text, when a regex is used to EXCLUDE a candidate.
const ANNOUNCEMENT_OPENING_CHARS = 120;

/** True when `text` OPENS like the announcement `re` identifies (exclusion-side matching). */
export function isAnnouncement(re: RegExp, text: string): boolean {
  return re.test(text.slice(0, ANNOUNCEMENT_OPENING_CHARS));
}

/**
 * Poll the gateway for alcode's per-run coding-session file reaching `status: succeeded` — the
 * model-independent proof the delegated session finished, and the ground truth the completion
 * wake rides on. `find` (not a shell glob) so an absent match in any single project dir does not
 * error; alcode writes under `<project>/.plans/<ticket>/_alcode/<stamp>.md` (or
 * `.plans/_alcode/` without a ticket), and worktree `.plans` symlinks back to the main
 * project so either path resolves. Sequential delegations of one ticket share the `_alcode/`
 * dir, so an earlier run's file matches immediately: `minCount` (default 1) requires that many
 * distinct succeeded files. Returns the newest matching session file path (the stamp in the file
 * name sorts chronologically).
 */
export async function waitForCodingSessionSucceeded(
  ctx: ScenarioContext,
  opts: { ticketId?: string; timeoutMs: number; minCount?: number },
): Promise<string> {
  const minCount = opts.minCount ?? 1;
  const sessionsDir = opts.ticketId ? `.plans/${opts.ticketId}/_alcode` : ".plans/_alcode";
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
    const hits = r.stdout.trim().split("\n").filter(Boolean);
    const newest = hits.sort().at(-1);
    if (hits.length >= minCount && newest !== undefined) return newest;
    lastStderr = r.stderr.trim();
    await delay(3_000);
  }
  throw new Error(
    `fewer than ${minCount} alcode coding-session file(s) under ${sessionsDir} reached ` +
      `"status: succeeded" within ${opts.timeoutMs}ms${lastStderr ? ` (last stderr: ${lastStderr})` : ""}`,
  );
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
