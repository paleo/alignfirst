# Architecture

`app.mjs` is the whole backend: an [Express 5](https://expressjs.com/) server that reads `PORT` from the environment and answers `Hello world from <branch>` on `GET /`.

No database, no build step, no frontend bundle. The branch name is resolved at startup, so each worktree's server identifies itself — handy when several workspaces run in parallel.
