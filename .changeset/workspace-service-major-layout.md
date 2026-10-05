---
"@alignfirst/workspace": minor
---

Added `ports.layout: "serviceMajor"`: each name owns a range of `maxWorkspaces` consecutive ports and a workspace takes its index in every range, so appending a name moves no existing port. The default `workspaceMajor` layout is unchanged. Under `serviceMajor`, `workspace list` shows the workspace index (`INDEX`) instead of a first port.
