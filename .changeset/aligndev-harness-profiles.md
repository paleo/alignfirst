---
"aligndev": minor
---

Breaking: the assistant's harness is resolved at each invocation, from `ALIGNDEV_ASSISTANT_HARNESS`, the detected coding agent or OpenClaw's exec runtime, and the `platform` setting is retired. Profiles name their `harness` instead of `agent`; `code.profile` gives way to the assistant profile's `defaultAgentProfile` or `code.fallbackProfile`, with new `openclaw` and `disabled` profiles. The coding agent no longer inherits npm launcher variables. The project inventory scans Git repositories without `.alignfirst-projects.json` markers, and `project free-ports` looks up the settings' `portRange`; `project init` and `--range` are removed.
