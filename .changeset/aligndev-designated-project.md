---
"aligndev": minor
---

Allowed a coding-agent assistant to carry tasks on several projects, each designated by a path, without leaving its starting directory. Simplified the playbook: shorter guides with fewer repeated instructions, and the assistant's own questions to the user are now numbered `A1`, `A2`…, while the agent's keep their `T` number. The assistant now runs a wait on a CI run, a deployment or a review in the background, so the session stays available. A run that ends with `auth_required` now prints the exact login command of its profile, also recorded in the session file and shown by `aligndev code --help`; `aligndev guide code` no longer carries login guidance.
