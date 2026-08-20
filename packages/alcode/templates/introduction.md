Run a coding agent through AlignFirst protocols with the `alcode` CLI. It wraps a coding-agent CLI for non-interactive use: it invokes a protocol, streams the run to a session file, and returns the result.

**Never implement, investigate, or modify the codebase yourself while delegating. Your role is to delegate and guide the agent.**

Run `alcode` from the root of the target project, so the agent works in the right repo. The project must contain a `.plans/` directory.

Set `ALIGNFIRST_CODE_AGENT={{AGENT}}` for every agent-dependent command. The selected coding agent must be installed and authenticated on the host.
