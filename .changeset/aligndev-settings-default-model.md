---
"aligndev": minor
---

Breaking: the settings file is now `~/.alignfirst/aligndev.settings.json`; move `~/.alignfirst/aligndev.config.json` there. New `code.defaultModel` sets the default model of new sessions, and a resumed session keeps its model. The project's companion directory is always writable for the coding agent. The playbook no longer runs a `remote` setup profile, and the project guide follows the new companion registry and dev-server port range.
