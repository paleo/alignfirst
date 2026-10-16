---
"@alignfirst/workspace": minor
---

Breaking: `ports.names` became `ports.declare`, whose entries are names or `{ name, range?, mainWorktree? }`, and the `ports.mainWorktree` pins moved into these entries. A `range` dedicates a block of the port range to one name, so an outside allowlist, such as OAuth callback URLs, can list its ports. Follow "Declare Workspace Ports" in the alignfirst-upgrade reference.
