---
"alignfirst": minor
"aligndev": patch
---

`plans.folder` in `.alignfirst.json` is now `plans.repositoryFolder`. The old key still works, with a deprecation warning on stderr; follow "Rename the Work-Files Folder Setting" in the alignfirst-upgrade reference. `alignfirst config --json` reports the new key either way, and `aligndev` reads it. The `alignfirst` README's manual setup now has two steps, and its companion section points to the setup guide.
