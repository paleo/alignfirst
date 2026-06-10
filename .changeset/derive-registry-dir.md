---
"@paleo/workspace": minor
---

Remove `registryDir`. The registry is now derived as `${runtimeDir}/shared-registry`, auto-symlinked per linked worktree by `workspace setup`. To migrate an existing registry: `workspace migrate-0.16 <old-registryDir>`.
