---
"@alignfirst/workspace": minor
---

Added `ports.layout: "serviceMajor"`: each name owns a range of `maxWorkspaces` consecutive ports and a workspace takes its index in every range, so appending a name moves no existing port. The default `workspaceMajor` layout is unchanged. `compute` now receives `step`, the distance between two consecutive offsets.
