---
"alignfirst": minor
"@alignfirst/alcode": minor
"@alignfirst/alproject": minor
"@alignfirst/docmap": minor
"@alignfirst/workspace": minor
"@alignfirst/openclaw-test": minor
"@alignfirst/openclaw-channel-mock-core": minor
"@alignfirst/openclaw-slack-mock": minor
"@alignfirst/openclaw-discord-mock": minor
---

Moved to the `@alignfirst` npm scope. `alignfirst` itself stays unscoped, and the previous names are deprecated and receive no further releases.

Replace the `@paleo/` prefix in your dependencies, then in the two scaffolded files that hardcode the scope as a path: the `include` of `./node_modules/@alignfirst/openclaw-test/docker-compose.yml` in `docker-compose.yml`, and `plugins.load.paths` under `node_modules/@alignfirst/openclaw-{discord,slack}-mock` in `openclaw.json`. A bumped dependency alone leaves `openclaw-test env up` failing on a missing Compose include, with the mock channels unloaded.
