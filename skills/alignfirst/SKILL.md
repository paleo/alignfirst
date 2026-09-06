---
name: alignfirst
description: "Collaborative problem-solving protocols. Read when the user names AlignFirst or a protocol alias: alspec, alplan, AAD, alcatchup, almerge, alreview, or aldescription."
license: CC0 1.0
metadata:
  author: Paleo
  version: "4.0.0"
  repository: https://github.com/paleo/alignfirst
---

Follow the requested protocol if its guide is already in context. Otherwise, run `npx -y alignfirst guide <protocol>` and follow it. Each named guide includes the shared conventions.

Protocol aliases: `alspec` → `spec`, `alplan` → `plan`, `al` or `AAD` → `aad`, `alcatchup` → `catchup`, `almerge` → `merge`, `alreview` → `review`, `aldescription` → `description`.

When no protocol is specified, run `npx -y alignfirst guide` to choose one. Add `--protocol-only` to a named guide command when the shared conventions are already in context.
