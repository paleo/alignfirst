---
"aligndev": minor
---

Added companion directory support. `aligndev code` writes its session files where `alignfirst config` locates them, makes the companion writable for the coder, and gives a new session the project context. `aligndev project` lists every Git main worktree as a project, except a work-files clone, and reports its companion directory.
