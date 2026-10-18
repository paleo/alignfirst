# Provenance

This package adapts the subagent example shipped with `@earendil-works/pi-coding-agent` 1.3.0 (`examples/extensions/subagent/index.ts` and `agents.ts`) and its local adaptation maintained at `/home/hop/th/env/adm/pi-agent/extensions/subagent/` during development.

The example supplied the isolated-process delegation, profile discovery, concurrency, chain substitution, and compact Pi-tool integration patterns. This package replaces process supervision, protocol parsing, trust validation, result storage, and lifecycle ownership. It does not import the local extension at runtime or install its profiles or prompt templates.

The upstream MIT notice, including `Copyright (c) 2025 Mario Zechner`, is preserved in full in [LICENSE](LICENSE).
