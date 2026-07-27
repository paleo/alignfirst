# Architecture

An [Express 5](https://expressjs.com/) server in four modules. No database, no build step, no frontend bundle.

`app.mjs` reads `PORT` from the environment, resolves the current branch at startup — so each worktree's server identifies itself when several workspaces run in parallel — and wires two routes:

- `GET /` renders the home page (`home-page.mjs`): one link per region, plus the export button.
- `GET /export?region=…` runs the export handler (`export-handler.mjs`), which reads the region's rows from `comparables.mjs` and answers with CSV.

`comparables.mjs` is the datastore stand-in: a literal keyed by region. The `west` region deliberately holds no rows, which is how the export's empty-region path gets exercised.
