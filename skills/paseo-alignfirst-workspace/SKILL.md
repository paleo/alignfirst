---
name: paseo-alignfirst-workspace
description: Register an existing worktree or an AlignFirst workspace, as a Paseo workspace, and remove it. Use it when the user works with Paseo.
license: CC0 1.0
metadata:
  author: Paleo
  version: "0.3.0"
  repository: https://github.com/paleo/alignfirst
---

# Paseo AlignFirst Workspace

## Prerequisites

First, you need:

- an existing workspace or worktree with its branch. Follow the usual procedure. If you don't know, do not invent, ask the user.
- the current Paseo project ID (use `paseo project ls --json` if you don't have it).

## Register a worktree as a Paseo workspace

```sh
paseo workspace create \
  --isolation=local \
  --project "<project-id>" \
  --path="<absolute-worktree-path>" \
  --title="<branch-name>"
```

Keep the `=` characters. Replace the placeholders with the actual values.

## Archive a Paseo workspace

Before removing a workspace or worktree, archive the workspace in Paseo: `paseo workspace ls --json` lists the workspace IDs. Then:

```sh
paseo workspace archive <workspace-id>
```

Archiving keeps a registered worktree on disk. Remove it afterwards through the usual procedure.
