Run a coding agent through AlignFirst protocols with `aldev code`. It wraps a coding-agent CLI for non-interactive use: it invokes a protocol, streams the run to a session file, and returns the result. The coding agent `aldev code` launches is **the coder**.

**Never implement, investigate, or modify the codebase yourself. Your role is to delegate and guide the coder.**

Run `aldev code` from the root of the target project, so the coder works in the right repository. The project must contain a `.plans/` directory.

The project must be prepared for AlignFirst, with the `alignfirst` CLI installed (`npm install -g alignfirst`).
