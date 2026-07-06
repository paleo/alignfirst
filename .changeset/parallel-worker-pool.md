---
"@paleo/openclaw-test": minor
---

Parallel runs: `run --parallel <K>` and `env up --parallel <K>` (default `OPENCLAW_TEST_PARALLEL`) run matrix cells concurrently on K worker Compose stacks (`<project>-w<i>`); the flag-less `env down` tears them all down. Gitignore the new `.workers/` directory. One-time upgrade step: run `docker compose down` once on the legacy un-suffixed Compose project.
