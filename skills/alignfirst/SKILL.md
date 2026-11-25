---
name: alignfirst
description: "Collaborative problem-solving protocols. Read when the user names AlignFirst or a protocol alias: alspec, alplan, AAD, alcatchup, alcatchupaad, alcatchupspec, almerge, alreview, or aldescription."
license: CC0 1.0
compatibility: Requires Node.js. The merge and review protocols also require Git.
metadata:
  author: Paleo
  version: "4.0.2"
  repository: https://github.com/paleo/alignfirst
---

Follow the requested protocol if its guide is already in context. Otherwise, run `npx -y alignfirst guide <protocol>` and follow it. Each named guide includes the ticket directory and work file rules; add `--protocol-only` when they are already in context.

Protocol aliases: `alspec` → `spec`, `alplan` → `plan`, `al` or `AAD` → `aad`, `almerge` → `merge`, `alreview` → `review`, `aldescription` → `description`. The `alcatchup` alias runs `npx -y alignfirst ticket --catchup` and then follows the user's instructions; `alcatchupaad` and `alcatchupspec` run it before the `aad` or `spec` protocol.

When no protocol is specified, run `npx -y alignfirst guide` to choose one. For workflow explanations, run `npx -y alignfirst guide overview`.

To install, configure or upgrade AlignFirst tooling in a project, run `npx -y alignfirst setup` and follow it.
