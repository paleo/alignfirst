---
"alignfirst": patch
---

Unknown and obsolete properties in `.alignfirst.json` and the companion registry are now ignored with warnings on stderr. Companion registration and removal preserve unrelated raw settings. Recognized settings remain validated, and `config --json` keeps stdout clean.
