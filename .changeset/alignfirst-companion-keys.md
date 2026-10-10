---
"alignfirst": minor
---

Registry keys now match a project's main worktree only: replace a parent-directory key with one entry per project (`alignfirst doctor` warns about keys that match nothing). Renamed `alignfirst companion add` to `companion register`: it creates the companion directory only with `--create-dir`, and refuses a project whose companion directory another key uses. Added `alignfirst companion unregister`, which removes the directory with `--remove-dir` (`--force` when not empty).
