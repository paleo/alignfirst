// Each scenario A<S> uses ticket ids in the ABC-0<S>0..ABC-0<S>9 range
// (e.g. A1 → ABC-010, ABC-011, …; A4 → ABC-040). Mechanical mapping gives an
// unambiguous leak signal: while running A<S>, any ABC-0<X>N with X ≠ S is
// bleed from another scenario. See the playbook-test README.md.

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const STARTER_ANNOUNCEMENT_RUBRIC = `A short announcement that a new thread is being opened (e.g. "Nouveau thread.", "Opening a thread."). A brief filler or commitment phrase ("Je regarde ça", "On y va") is fine. No questions, no prompts for input, no narration of the user's request.`;

export const NEW_WORK_QUESTION_RUBRIC =
  "A short message asking the user about the new work: requests the ticket id, the change scope/description, the change type (feat/fix/refactor/chore), or any combination. May also include a brief announcement clause alongside. No off-topic content, no offers to do something else.";

export const OFF_PROJECTS_CHAT_RUBRIC = `A short conversational reply to a non-project message ("Salut, ça va ?" or similar). Tone matches the inbound (greeting / small talk). Does NOT mention any project, ticket, branch, worktree, thread, setup, environment, or coding work. Does NOT ask the user to pick a project or describe a task. Pure off-projects chat.`;

export const askWhichProjectRubric = (ticketId: string): string =>
  `A short follow-up message asking the user **which project** the ticket belongs to. The ticket id (${ticketId}) appears somewhere in the message — main clause, aside, or parenthetical all count. Does NOT announce setup, does NOT name a specific project as if it were assumed. May be in the user's language (French expected here).`;

export const unknownProjectRubric = (projectName: string): string =>
  `A short follow-up message acknowledging that the project named by the user (${projectName}) is not found under \`~/projects/\`. Asks the user to confirm the name or supply the correct one. Does NOT proceed with setup, does NOT pretend the project exists.`;

export const INVESTIGATION_SUMMARY_RUBRIC = `A summary or relay of an investigation finding from the coding agent. May be a paraphrase ("D'après l'analyse, …") or a direct relay ("C'est fait." / "It's done."). Any trailing question or offer about next steps is acceptable — including which fix to apply, whether to proceed, preferred direction, whether to open a ticket, or whether to start working on it. Does NOT announce that a worktree setup has happened, does NOT pretend the coding work has already started.`;

export const statusExistingWorktreeRubric = (ticketId: string, branch: string): string =>
  `A status report for an existing workspace. References the ticket id (${ticketId}) or the branch (${branch}). Mentions that a worktree is already set up / registered / in place / ready (path, slot, "ready", "existe", "already exists" all count). Reporting the worktree's creation timestamp from its metadata is fine — that's data, not an action claim. Reject ONLY if the message announces, as a fresh user-facing action, that the agent itself just created a new worktree to fulfill this request (e.g. "Je viens de créer le worktree" with no prior-existence wording).`;

export const statusBranchOnlyRubric = (ticketId: string, branch: string): string =>
  `A status report after the worktree was set up. References the ticket id (${ticketId}) or branch (${branch}), the worktree path or slot, and the bootstrap status (running / ready / failed). The standard \`Worktree : … / Branche : … / Bootstrap : …\` template counts. Reject only if the message explicitly claims the branch was newly created from scratch (e.g. "j'ai créé une nouvelle branche ABC-080/fix").`;

export const statusNoBranchRubric = (ticketId: string): string =>
  `A short report that no workspace exists for ticket ${ticketId} — no branch, no worktree, "rien encore", "no branch yet", "pas de branche", "nothing started". Does NOT announce that a worktree was created. May offer to start a new workspace for the user.`;

// The `[WORK]` header, posted on entering WORK mode, restates the project and
// ticket. The values may be bolded (`**v**` on Discord, `*v*` on Slack) or
// not, so bold markers are optional; `[WORK]` is kept literal. Tolerant
// substring match (no ^/$ anchors), case-insensitive.
const boldOpt = "\\*{0,2}";
export const workHeaderRegex = (project: string, ticketId: string): RegExp =>
  new RegExp(
    `\\[WORK\\][\\s\\S]*${boldOpt}${escapeRe(project)}${boldOpt}[\\s\\S]*${boldOpt}${escapeRe(ticketId)}${boldOpt}`,
    "i",
  );

export const workHeaderMultiProjectRegex = (projects: string[], ticketId: string): RegExp =>
  new RegExp(
    `\\[WORK\\][\\s\\S]*${boldOpt}${projects.map(escapeRe).join("\\+")}${boldOpt}[\\s\\S]*${boldOpt}${escapeRe(ticketId)}${boldOpt}`,
    "i",
  );
