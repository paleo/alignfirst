---
"alignfirst": minor
---

Breaking: the companion registry now lists `projects`, each with an explicit companion `dir` and optional `items` settings (`"companion"`, `"project"` or `"auto"`). `companion register --dir <path>` places a new companion anywhere; `companion unregister --remove-dir` deletes only a directory inside `~/.alignfirst/companions`. An existing registry with `paths` must be converted, as the setup guide's upgrade reference describes.
