---
"aligndev": patch
---

A settings profile that still names its `agent` instead of `harness` loads again: `agent` reads as `harness`, with a deprecation warning on stderr. The settings file is not rewritten.
