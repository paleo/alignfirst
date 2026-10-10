---
"aligndev": minor
---

`aligndev project status` resolves a relative path against the working directory, so `status .` works from a project. Renamed the `.alignfirst.md` companion item to `.alignfirst-instructions`. The playbook unregisters a project's companion before removing the project, and deletes the companion directory when the user chooses to.
