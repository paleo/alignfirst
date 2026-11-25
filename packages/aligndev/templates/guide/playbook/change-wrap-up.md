# Runbook: Change wrap-up

Read this runbook on the completion turn of a run that changed code, before you report the change as finished, and when the user brings up acceptance testing. Launch every run it asks for as `{{GUIDE}} code` describes.

## Always test the work manually

Manual testing is what ends a code change: beyond the automated checks, the change gets exercised before any MR/PR and before telling the user it's finished. On the completion turn, verify first, then report, one consolidated message that ends the turn:

1. Confirm the applicable checks passed ("Tests, lint, build" in your working-session guide).
2. Exercise the change the way its users would, through the agent or yourself, with the tool that reaches it (browser automation, `curl`, …). On a project with a dev-server, start it and drive the change in the UI. Anything else: run the CLI, the simulator, … Skip only when the project offers nothing to drive, and say so in the report.
{{#thread}}
3. When the test shows something on screen, have the test save screenshots; attach them to the report (`message`, attachments).
{{/thread}}
{{#app}}
3. When the test shows something on screen, have the test save screenshots under `~/.openclaw/workspace/scratch/` or the project's `.local/`; attach each to the report on a line of its own, `MEDIA:<absolute path>`.
{{/app}}
{{#codingAgent}}
3. When the test shows something on screen, have the test save screenshots; give their file paths in the report.
{{/codingAgent}}
4. When the project uses a dev-server, complete the log review below.
{{#openclaw}}
5. End the turn on the report: the run's outcome as the agent's account, plus what the manual test verified. That final message is the delivery — a report written earlier in the turn never posts, and a completion turn that ends on `HEARTBEAT_OK` after a completed run reports nothing at all.
{{/openclaw}}
{{#codingAgent}}
5. End the turn on the report: the run's outcome as the agent's account, plus what the manual test verified.
{{/codingAgent}}

An error met while testing is yours to handle, even when it looks unrelated to the change. You're the developer: investigate, then decide —

- Small fix, anecdotal for the codebase: fix it (new agent session), even off-scope.
- Too large or too far from the ticket: leave the code alone; when a ticketing platform (Jira, Linear, …) is available to you, look for an existing ticket, and propose to create one when there is none.

Either way, the report states the error and your decision.

### Dev-server log review

After using a dev-server, have a separate no-protocol agent run with the smallest available model (the default one when the child has no model list) inspect its logs: give it the log locations and ask for errors or unusual behavior. It is a background run like every agent run, so the manual test's verdict lands on its completion turn.

Clean logs are required for the manual test to pass.

## Acceptance testing

When the user brings up acceptance testing, first be sure who runs it — ask when the request leaves a doubt:

{{#thread}}
- **You run it.** You need to know what to test: the scenarios may already be in your context — the ticket, the thread, the spec artifacts (`{{ALIGNDEV}} code new --ticket <id> --catchup`). If you can't find them, ask the user rather than inventing them. Once known, test as in "Always test the work manually".
{{/thread}}
{{#conversation}}
- **You run it.** You need to know what to test: the scenarios may already be in your context — the ticket, the conversation, the spec artifacts (`{{ALIGNDEV}} code new --ticket <id> --catchup`). If you can't find them, ask the user rather than inventing them. Once known, test as in "Always test the work manually".
{{/conversation}}
- **The user runs it.** They only need the dev-server up with its URL.

## Reviewing your own work

A review the user asked for always runs, on the whole branch, in the form they name if any. One you start yourself costs several agent runs, so it follows the unreviewed change: the commits added since the branch's last review, or the whole branch against its base when it was never reviewed. The ticket's latest review file names the reviewed commit, on its `Reviewed commit` line. A review file without that line counts as never reviewed. Measure a never-reviewed branch with `git diff --shortstat <base branch>...HEAD`. On a reviewed branch, add up the lines that `git log --first-parent --no-merges --format= --shortstat <reviewed commit>..HEAD` prints: it counts the branch's own commits and leaves out the merged base-branch commits.

- **Small and low-risk** — skip the review, and give the reason in your report. Small is roughly under 50 changed lines, generated files and lockfiles aside. Low-risk is wording, documentation, styling, a configuration value, or an isolated fix that a test covers.
- **Anything else** — run the review workflow of `{{GUIDE}} code-review`. Its scope and its form go in the message, as that guide describes:
  - **Scope** — on a reviewed branch, pass the reviewed commit as the starting commit. Have the whole branch reviewed instead when the new commits rework what was reviewed, or dwarf it.
  - **Form** — the agent chooses by default: the light review for a minor change, the regular one otherwise. Name the form when you know more than the diff shows: `Regular review.` for a small change where a mistake would be costly, `Light review.` for a larger one that is minor, such as a mechanical rename.

Decide before creating a MR/PR, and again after each change added to an existing one.

## Merge/Pull requests

You are the judge of when the ticket's scope is done — a ticket can span several coding sessions, so no single run completion decides it. When you judge it done, create the MR/PR without asking.

Before creating it: the applicable checks pass ("Tests, lint, build" in your working-session guide), and you exercised the change manually ("Always test the work manually" above). Then review the branch as "Reviewing your own work" decides, without asking.

After creating the MR/PR (via `{{ALIGNDEV}} code`):

- Post the MR/PR link.
- Wait for the CI to run (wait two minutes, then check; if it's still pending, wait another two minutes, and check again). If it fails, report the failure, then fix it. If it succeeds, report the success to the user.

## Protected directories

When the deployment or the git host refuses a change under a directory — typically `.github/workflows/`, which a token without the `workflow` scope cannot push — the branch carries the proposed file at `.<dirname>-proposed/` with the rest of the path unchanged: `.github/workflows/ci.yml` becomes `.github-proposed/workflows/ci.yml`. The PR description states that a developer must apply the proposed files by hand. Pass this instruction to the agent, which writes the copy and the description.
