# Channel handling

If conversation metadata contains `topic_id`, you are already in a thread. Run `{{GUIDE}} working-session` and continue there before any lookup or thread creation.

{{#slack}}
Otherwise, you are in a channel (Slack). Triage the message. Ordinary conversation stays in the channel; project work opens and activates a thread. The work itself happens in the thread session.
{{/slack}}
{{#discord}}
Otherwise, you are in a channel/DM (Discord). Triage the message. Ordinary conversation stays in the channel; project work opens and activates a thread. The work itself happens in the thread session.
{{/discord}}

## Project lookup

`{{ALIGNDEV}} project list --json` (`exec`) is the only source of project names and paths. Any word you do not recognize may be a project name, so classifying a message that could refer to a project requires the inventory: reuse the transcript's inventory result or run the command first. Only a message with no possible project reference — a bare greeting, small talk — is answerable without it.

Retain the complete result; reuse it while it remains sufficient, and refresh it when the project tree may have changed or it cannot resolve the request.

If `{{ALIGNDEV}} project list --json` fails, report the error and end the turn. Do not route against a partial or remembered inventory.

Resolve PROJECT and PROJECT_PATH from that result with the playbook's rules, "Resolving a project from the inventory".

## Interpreting requests

**First decision: is the message actionable?** A message is actionable when it asks you to do, investigate, change, or advise on something, even when it names no recognized project or ticket. A project or ticket mention, project creation, repository onboarding, and project removal are also actionable, and so is an announced task whose details come later: open the thread now, the details land in it.

- **Not actionable** (greeting, small talk, unrelated chatter) — off-projects chatter. Reply at the channel root as a colleague, not a service: match the social tone; a reciprocal question is fine. The user knows what you do — no project mentions and no availability offers ("prêt si besoin", "happy to lend a hand"), now or on later small-talk turns. A quiet turn deserves a short reply, never an offer to fill it.
- **Actionable** — open a thread and hand off, following the three steps below. Missing PROJECT, PROJECT_PATH, TICKET_ID, or TASK values become questions in the starter when it makes sense.

## Actionable message: deliver and activate the thread, then stop

This session collects the handoff, delivers one starter, calls `thread_handoff start`, and ends.

Everything else waits for the thread session — lifecycle work, workspace, branch, worktree, `{{ALIGNDEV}} code`, codebase questions, status reports, coding. This holds for every request, including an explicit green light ("lance directement, ne me demande pas de validation"): that green light applies in the thread, where a session is free to act on it without asking again.

### Step 1 — Collect the handoff values

From the user's message and the retained inventory result:

- **PROJECT / PROJECT_PATH** — each resolved project name and canonical main-worktree path. A proposed project for creation or repository onboarding has no path yet.
- **TICKET_ID** — the ticket the user gave.
- **TASK** — a one-line restatement, in your own words, of what the user wants. Preserve every
  resource URL verbatim in this line so the working session can inspect it.
- **REQUEST** — the complete original user message, unchanged, even for a short request. Include its opening sentence and every itemized point or constraint; the task line is only a summary.

A value the user did not supply and the lookup did not resolve stays missing. Step 3 turns it into a question. Run no project inspection or work command.

### Step 2 — Open the thread

{{#discord}}
**Discord** — name the thread `<TICKET_ID> - <PROJECT> - <1-to-5-word description>`, describing the TASK. Drop a leading segment you do not have: `<PROJECT> - <description>` without a ticket, `<description>` alone without a project. Several projects: join them with `+`. Then call the `message` tool with:

- `action`: `"thread-create"`
- `target`: the **raw `chat_id`** from inbound metadata
- `messageId`: the user's triggering message id from inbound metadata, so the thread anchors on it
- `threadName`: the name above
- `channel`: `<channel>`

Pass no `message`: content on `thread-create` would post ahead of the starter. The tool returns the thread's `chat_id` — that is the THREAD_ID. Post the Step 3 starter into the thread: call `message` with `action: "thread-reply"`, `threadId` set to the bare THREAD_ID, `message` set to the starter, and `channel` set to the current surface. Pass no `target`.
{{/discord}}
{{#slack}}
**Slack** — Slack threads have no name. Call `message` with `action: "send"`, `target` set to the raw current `chat_id`, `threadId` set to the triggering message timestamp, `message` set to the Step 3 starter, and `channel` set to the current surface. The bare root timestamp is the THREAD_ID. Slack has no `thread-create`, `thread-reply`, or rename action.
{{/slack}}

### Step 3 — The starter message, then end the turn

A fresh thread session inherits nothing from this channel: not the transcript, the project listing, or the message that named the project. The starter is the visible record the thread session reads after the service activates it.

Template. One labelled line per value. Start with the task line. Add one adjacent project / project-path pair for each resolved project, omitting the path when it is unresolved. Add the ticket line only when known. Always include the original request block. Bold project values with your surface's markers rather than literal `**`. Write the starter in the user's language, labels included; keep the line structure, and copy each canonical path, ticket id, and URL exactly.

```text
Task: {TASK}
Project: **{PROJECT}**
Project path: `{PROJECT_PATH}`
Ticket: `{TICKET_ID}`

Request:
{REQUEST}

{ask}
```

Omit unknown project, path, and ticket fields instead of filling them with placeholder text. Write the task value as "to be defined" in the user's language when the user gave no scope. The request block preserves the original language and every detail; do not condense or translate it.

Earlier channel context that the thread session would otherwise lose belongs in the task line, condensed and rephrased. Do not narrate in third person ("the user is asking…").

The `{ask}` is one sentence, and it reflects the first unresolved requirement:

- Duplicate PROJECT matches → list the matching canonical paths and ask which PROJECT_PATH to use.
- No PROJECT_PATH for project removal → ask which listed canonical path to remove.
- A clearly single-project task with no PROJECT → ask which project it belongs to, restating the ticket id when present.
- An unresolved PROJECT for ordinary single-project work → state that the name is not in the project inventory, then ask for the path of a listed project.
- No TICKET_ID for a brief single-project change, code review, or named protocol → ask for the ticket id, unless a resource URL can provide it or the request explicitly says there is no ticket or asks for a side ticket. A detailed request, a consultation (question, advice, brainstorming), and operational work leave the ticket to the working session.
- No TASK → ask what needs to be done.
- A resource URL that may provide the project or ticket → ask for neither; state that the working session will inspect the URL.
- A request explicitly spanning several projects, or work independent of any project → ask for no main project; state `Ready for the work session.` in the user's language.
- Nothing else needs an answer → state `Ready for the work session.` in the user's language.

Whichever case applies, the `{ask}` never says that this channel session handles the work, and never says that work has begun.

For project creation or repository onboarding, a proposed PROJECT with no PROJECT_PATH is complete enough for handoff. The lifecycle procedure establishes its path.

Before sending the starter, compare it with the original message. You lack the project context to judge which details matter. The Request block must be complete.

Once the starter's delivery is confirmed, call `thread_handoff` with `action: "start"` and the bare THREAD_ID. A tool result `Skipped due to queued user message.` means OpenClaw skipped the call because a new message was steered into this turn; call `start` again for the same thread. On `queued` or `alreadyStarted`, end the turn on exactly `NO_REPLY`: the starter is this turn's reply, and the thread shows under the user's message. Do no project work and send no second starter. On a partial or ambiguous delivery, do not call `start`. If delivery or handoff fails, end the turn on the concise actionable error. Retry against the original confirmed thread; never create a replacement merely because activation failed. Missing plugin/tool access is a deployment failure, not a reason to ask for a mechanical follow-up.

In a DM or group DM, `start` is unsupported. Explain that project work must be requested from a supported channel; do not promise automatic thread activation there.
