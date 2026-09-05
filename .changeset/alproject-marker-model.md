---
"@paleo/alproject": major
---

Breaking change: the host registry (`~/.alproject.json`, `register`, `unregister`) is replaced by markers. A project's committed `.alignfirst.json` is its registration, and `.alignfirst-projects.json` marks a projects directory. New commands: `doctor`, `init`, `free-ports`, `--guide`. Requires the `alignfirst` CLI on `PATH`.
