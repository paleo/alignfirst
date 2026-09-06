// Each scenario A<S> uses ticket ids in the ABC-0<S>0..ABC-0<S>9 range
// (e.g. A1 → ABC-010, ABC-011, …; A4 → ABC-040). Mechanical mapping gives an
// unambiguous leak signal: while running A<S>, any ABC-0<X>N with X ≠ S is
// bleed from another scenario. See the alignfirst-developer-tests README.md.

export const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The starter is an exact durable handoff record. Work is activated explicitly
// after confirmed delivery and may begin immediately when no input is missing.
export const STARTER_HANDS_OFF_RUBRIC =
  "A thread-opening handoff message from a chat bot. It faithfully carries the known project, canonical path, ticket and original task details needed by a fresh thread session. It may ask a specific question when information is genuinely missing, or state that complete work is starting now. Reject a generic request for a reply merely to activate the thread, invented details, omitted supplied constraints, or claims of completed repository work that could not have happened before the starter.";

export const HANDOFF_ASK_RUBRIC = `A thread handoff that asks for genuinely missing task information, such as a project, ticket, scope or confirmation required by the user's constraints. Reject a content-free activation request such as "reply here so I can start" or "send any message to launch the session".`;

export const NEW_WORK_QUESTION_RUBRIC =
  "A message asking the user about the new work: requests the ticket id, the change scope/description, or any combination. The core requirement is that it asks the user for the missing work details. A brief announcement clause or a leading planning/reasoning note alongside is fine, and so is OpenClaw's structured prompt format (numbered options, 'Reply with the number…' guidance). No off-topic content, no offers to do something unrelated.";

export const askWhichProjectRubric = (ticketId: string): string =>
  `A message asking the user **which project** the ticket belongs to. The ticket id (${ticketId}) appears somewhere — main clause, aside, or parenthetical all count. A thread-opening announcement before the question is fine, and so are OpenClaw's structured prompt format (numbered options, 'Reply with the number…' guidance) and a promise about what follows the user's answer (the work session starting, the workspace being set up): future tense is the handoff, not an action claim. Does NOT claim a workspace/worktree/branch is already created or being created right now, and does NOT name a specific project as if it were assumed. May be in the user's language (French expected here).`;

export const unknownProjectRubric = (projectName: string): string =>
  `A message acknowledging that the project named by the user (${projectName}) is not found / not known, and asking the user to confirm the name or supply the correct one. A thread-opening header before the acknowledgement — project name as given, ticket, a one-line task restatement — is fine; naming ${projectName} in that header is quoting the user, not pretending the project exists. Reject only if the message proceeds with setup or treats the project as valid.`;

export const statusExistingWorktreeRubric = (ticketId: string, branch: string): string =>
  `A status report for an existing workspace. References the ticket id (${ticketId}) or the branch (${branch}). Mentions that a worktree is already set up / registered / in place / ready (path, workspace name, "ready", "existe", "already exists" all count). Reporting the worktree's creation timestamp from its metadata is fine — that's data, not an action claim. Reject ONLY if the message announces, as a fresh user-facing action, that the agent itself just created a new worktree to fulfill this request (e.g. "Je viens de créer le worktree" with no prior-existence wording).`;

export const statusBranchOnlyRubric = (ticketId: string, branch: string): string =>
  `A status report after the worktree was set up. References the ticket id (${ticketId}) or branch (${branch}), the worktree path or workspace name, and the workspace status (running / ready / failed). The standard \`[WORKSPACE] … / Worktree : … / Branche : … / Status : …\` banner counts (older \`Bootstrap :\` label too). Reject only if the message explicitly claims the branch was newly created from scratch (e.g. "j'ai créé une nouvelle branche ABC-080/retry-logic").`;

export const statusNoBranchRubric = (ticketId: string): string =>
  `A short report that no workspace exists for ticket ${ticketId} — no branch, no worktree, "rien encore", "no branch yet", "pas de branche", "nothing started". Does NOT announce that a worktree was created. May offer to start a new workspace for the user.`;
