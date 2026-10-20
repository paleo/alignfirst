---
"aligndev": minor
---

Added automatic singleton-profile selection and per-agent profile-local `default` flags. Unknown or obsolete settings now warn on stderr and are ignored. Convert retired launch fields and `code.defaultProfiles` maps manually, preserving profile names. Historical unnamed resumes retain built-in defaults.
