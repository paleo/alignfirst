---
"@alignfirst/pi-subagent": patch
"@alignfirst/pi-background": patch
---

On Linux, cleanup reads the process table from `/proc` and no longer fails when `ps` is slow. Processes it cannot read, such as other users' under `hidepid`, are skipped.
