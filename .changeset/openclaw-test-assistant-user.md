---
"@alignfirst/openclaw-test": minor
---

Renamed the gateway container user from `claw` to `assistant`. The home directory moves from `/home/claw` to `/home/assistant`, and the `CLAW_UID` and `CLAW_GID` build arguments become `ASSISTANT_UID` and `ASSISTANT_GID`. Consumers must update their `Dockerfile`, `docker-compose.yml` and any mount path that targets the gateway home.
