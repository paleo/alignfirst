# AlignFirst Guide

Follow the requested protocol if its guide is already in context. Otherwise, load it with the command below. Each named guide includes its protocol and shared conventions; add `--protocol-only` when those conventions are already in context.

## Choose a protocol

Use spec → plan → execution for most tasks, especially when the design is uncertain. Use AAD for small changes or follow-up work. Execute a written plan in a fresh agent session.

| Protocol | Purpose | Command |
| --- | --- | --- |
| Specification (`spec`, `alspec`) | Investigate, discuss, and write a technical specification. | `{{CMD}} guide spec` |
| Planning (`plan`, `alplan`) | Turn a specification into implementation plans. | `{{CMD}} guide plan` |
| Align-and-Do (`AAD`, `al`) | Investigate, agree, implement, and summarize a small change. | `{{CMD}} guide aad` |
| Catch up (`catchup`, `alcatchup`) | Load the task history, then continue or summarize. | `{{CMD}} guide catchup` |
| Merge (`merge`, `almerge`) | Merge an incoming branch and resolve conflicts. | `{{CMD}} guide merge` |
| Review (`review`, `alreview`) | Review committed branch changes against a base branch. | `{{CMD}} guide review` |
| Description (`aldescription`) | Write a concise description of implemented work. | `{{CMD}} guide description` |

For more detail on workflows and the ticket lifecycle, read `{{CMD}} guide overview`.
