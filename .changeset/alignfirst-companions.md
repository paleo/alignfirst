---
"alignfirst": minor
---

Added companion directories, declared in `~/.config/alignfirst/companions.json`, to keep a project's AlignFirst files outside its repository. A separate `_aligndev` session tree is archived and restored along with `.plans`. `alignfirst context` now prints the project instructions from `.alignfirst.md`. In `alignfirst config --json`, `source: "project"` replaced `"root"`, and the report gained `companion` and `locations`.
