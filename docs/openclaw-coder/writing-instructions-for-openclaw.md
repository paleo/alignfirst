# Writing workspace & playbook files — heuristics

Hard-won notes from tightening the `myclaw` workspace files (`openclaw-coder/playbook-test/workspace/*.md`) and the `openclaw-coder-playbook` skill (`skills/openclaw-coder-playbook/SKILL.md` + `references/*.md`) against test regressions. Read before editing any of them. Read [`openclaw-context-engineering.md`](./openclaw-context-engineering.md) first for the loading model, and [`openclaw-test-architecture.md`](./openclaw-test-architecture.md) for how the harness exercises these files.

## One rule, stated once

No "Important:", no all-caps emphasis, no triple-bullet restatement of the same point. There are a lot of things that matter. The more you insist, the more diluted later content becomes.

## Template + variations beats N full examples

A single labelled template plus a short list of variation tails beats four full-example bullets, and stops the agent from compressing the template away. Bad:

```text
- "Setting up the workspace now…"
- "Spinning up the environment…"
- "Getting the worktree ready…"
- "Preparing the branch…"
```

Good:

```text
Project: {P} — Ticket: {T} — Audience: {tech | non-tech}
Task: {task}

{ask}
```

Then vary the parts that carry no value — the setup signal, for instance: "Setting up the workspace", "Spinning up the environment", "Getting the worktree ready", "Preparing the branch". Note the template carries no literal `**`: instruct the agent to bold the values, since hardcoded `**` gets copied verbatim and renders literally on surfaces (e.g. Slack `message`-tool posts) that don't run the Markdown converter.

## Temporal anchors are required

"From now on" / "first user-facing action" / "before X" need an event the agent can pin to. "Eventually" / "soon" don't survive a hot model. If you write "Once the thread exists…", make sure the previous sentence pinpoints when the thread exists.

## Per-surface clauses, not blanket rules

Channel/DM and thread sessions behave differently; phrase as "Channel/DM: …. Thread: ….". A blanket "never X" tends to break a sibling path — e.g. a "never emit free-form text in a channel session" rule kills the off-projects auto-stream that the same playbook relies on elsewhere.

## The thread is its own source of truth

Thread sessions are fresh — they don't inherit the channel session's transcript (see the Discord history gap in [`openclaw-context-engineering.md`](./openclaw-context-engineering.md#discord-vs-slack-thread-history--upstream-gap)). Recover project + ticket with `message action: "read"` on the thread: the starter carries project, ticket, audience, and the task. A fresh **Discord** thread session sees only the thread's *own* messages — not the channel message that named the project (it's the thread's parent, excluded from the thread message list), and `read` returns the channel title, not the thread name. So the starter must carry everything forward; don't rely on the original message surviving. Never from `ls ~/projects/` and never from a ticket prefix (`ABC-…` is a label, not a project namespace).

This is why the channel session's starter is the only place the handoff values can live, and why it must state the task rather than assume the user will restate it. The message that wakes the thread session is often content-free ("vas-y", "ok").

## Don't treat a derived value as redundant

When step 1 of a procedure produces a value (project name, ticket id, branch name) and a later step would use it, restate the value in the later step's required output. "State X, then post an ack" leaves room for the agent to drop X from the ack. Collapse to: "Post `<form including X>`".

This is a common cause of an otherwise-correct run failing an assertion. Concrete example from `A1-new-work-to-be-done`: after the user supplied a ticket in-thread, the ack had to restate both project and ticket and announce workspace setup. The agent's tool-call trace confirms it read the whole chain correctly (dispatcher → `working-session.md` → `project-workspace-setup.md` → the project's `DEVELOPMENT.md` → `workspace --guide`), yet the ack still came out as *"Simple UI tweak → AAD workflow. Je lance ça."* — naming the internal AlignFirst protocol instead of the setup signal. The reads happened; the ack form was the gap.

## The other side: a value already on screen gets dropped

The rule above pushes values into a required output. Push the *same* values into two outputs a few minutes apart and the agent drops the second one — correctly, from its point of view: the user can already see them.

This killed the first version of the channel-bootstrap redesign. The channel starter was given the project, ticket, audience and task; the thread session was then still asked to open with a `[WORK]` banner carrying the same four. Claude Sonnet 5 skipped the banner and posted nothing until the workspace was up, two minutes later. The fix was structural, not more insistence: the starter is the thread's record, and the thread session opens with a bare setup signal that restates nothing.

So before requiring an output, check what is already in the thread. Restate a value the agent derived; don't restate one the user is looking at.

The `[WORKSPACE]` banner is how a tagged header came back without reviving the failure: it rides on the workspace report the session must post anyway (worktree, branch, status, URLs — all fresh values), anchored to a concrete event (the workspace reaching `ready`/`failed`), with project and ticket as a two-value tagline on data the model cannot skip.

## A nearby auto-loaded doc can crowd out the procedure

The same A1 ack failed **8 of 10** iterations here while the equivalent passed ~9 of 10 in the predecessor setup. The difference was structural, not luck: the workspace `AGENTS.md` was changed from a self-contained dispatcher (first action = read the surface playbook) to *"load the `alignfirst-coaching` skill, then follow its `dispatcher.md`"* (that coaching skill has since been retired into the alcode guide (today `alcode --openclaw-guide`)). That makes the agent read the skill's `SKILL.md` **first** — and that file foregrounds *"Light Workflow (AAD) — for straightforward changes like moving a button."* Faced with "make the export button bold," the agent matches that framing and surfaces the protocol choice in the thread, ahead of the worktree/branch setup the playbook actually wants.

Lesson: the file the agent reads *first* on a turn sets its frame. If that file is coaching/vocabulary-heavy (protocol names, workflow taxonomies), its language leaks into user-facing output. Keep the dispatch entry point pointed straight at the procedural playbook; defer delegation/coaching material until the agent is actually delegating.

## Doc-obedience is per-iteration

If the same agent ignores a procedure on one run and follows it on another, the doc is probably ambiguous, not unlucky — but confirm the rate before rewriting. A single failure in ten green runs is variance, not a defect; tightening a 90%-reliable instruction can over-constrain the sibling paths. Measure first:

```sh
npm run e2e -- --channel discord-mock --iterations 10 --max-failures 10 A1-new-work-to-be-done
```

`--max-failures` defaults to `1` (aborts the pair after the second failure), so raise it to see the full pass/fail rate; omit `--stop-on-fail`. Only if the failure rate is material, tighten the structure — one sentence, one template, one ordering — and re-run to confirm the fix sticks across iterations.

## Watch out for `--iterations` matrix cost

Editing a bind-mounted file propagates live (the workspace dir, the playbook skill, and the `@paleo/alcode` package — including its `templates/` guides — are all mounted into the gateway), but iterations that started before your edit ran against the old text. After a substantive edit, expect to re-run from scratch. Each cell recreates the bus + gateway for fresh state and costs real API tokens (gateway turns + judge), so scope iteration counts deliberately.
