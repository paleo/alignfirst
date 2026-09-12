// Each scenario A<S> uses ticket ids in the ABC-0<S>0..ABC-0<S>9 range
// (e.g. A1 → ABC-010, ABC-011, …; A4 → ABC-040). Mechanical mapping gives an
// unambiguous leak signal: while running A<S>, any ABC-0<X>N with X ≠ S is
// bleed from another scenario. See the alignfirst-developer-tests README.md.

export const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const NEW_WORK_QUESTION_RUBRIC =
  "A message asking the user about the new work: requests the ticket id, the change scope/description, or any combination. A plain question about what needs to be done on the project ('Que faut-il faire sur nimbus ?', 'What should we do on nimbus?') is a scope request and passes; do not judge its wording. A 'Task: to be defined' line shows the missing scope and is fine. Fail only when the message asks the user nothing. A brief announcement clause or a leading planning/reasoning note alongside is fine, and so is OpenClaw's structured prompt format (numbered options, 'Reply with the number…' guidance). No off-topic content, no offers to do something unrelated.";

export const askWhichProjectRubric = (ticketId: string): string =>
  `A message asking the user **which project** the ticket belongs to. The ticket id (${ticketId}) appears somewhere — main clause, aside, or parenthetical all count. A thread-opening announcement before the question is fine, and so are OpenClaw's structured prompt format (numbered options, 'Reply with the number…' guidance) and a promise about what follows the user's answer (the work session starting, the workspace being set up): future tense is the handoff, not an action claim. Does NOT claim a workspace/worktree/branch is already created or being created right now, and does NOT name a specific project as if it were assumed. May be in the user's language (French expected here).`;

export const unknownProjectRubric = (projectName: string): string =>
  `A message acknowledging that the project named by the user (${projectName}) is not found / not known, and asking the user to confirm the name or supply the correct one. A thread-opening header before the acknowledgement — project name as given, ticket, a one-line task restatement — is fine; naming ${projectName} in that header is quoting the user, not pretending the project exists. Reject only if the message proceeds with setup or treats the project as valid.`;

export const statusBranchOnlyRubric = (ticketId: string, branch: string): string =>
  `A status report after the worktree was set up. References the ticket id (${ticketId}) or branch (${branch}), and the workspace status (running / ready / failed). A path, workspace name, or formatting marker is not required. The standard \`[WORKSPACE] … / Worktree : … / Branche : … / Status : …\` banner counts (older \`Bootstrap :\` label too). Reject only if the message explicitly claims the branch was newly created from scratch (e.g. "j'ai créé une nouvelle branche ${branch}").`;

export const statusNoBranchRubric = (ticketId: string): string =>
  `A short report that no workspace exists for ticket ${ticketId} — no branch, no worktree, "rien encore", "no branch yet", "pas de branche", "nothing started". Does NOT announce that a worktree was created. May offer to start a new workspace for the user.`;
