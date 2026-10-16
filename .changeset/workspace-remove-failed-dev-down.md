---
"@alignfirst/workspace": patch
---

Fixed `workspace remove` leaving the dev server running when `dev down` failed, for example on a config the package refuses. It now kills the recorded processes and warns that the callback `stop()` did not run.
