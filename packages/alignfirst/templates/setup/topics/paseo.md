# Paseo

When the user works in Paseo, recommend the global `paseo-alignfirst-workspace` skill. With the user's approval, install it:

```sh
{{SKILLS}} add https://github.com/paleo/alignfirst --global --yes --skill paseo-alignfirst-workspace </dev/null
```

Add `--agent <host>` to target the user's coding host (`{{CMD}} setup guide skills`). Recommend adding this line to the system prompt in Paseo's settings:

```text
You are running inside Paseo.
```

Keep the project's hooks in `paseo.json`. Paseo runs them inside the target worktree. Use the project's invocation form when it differs:

```json
{
  "worktree": {
    "setup": "{{CMD}} workspace setup",
    "teardown": "{{CMD}} workspace teardown"
  }
}
```

The report shows whether `paseo.json` exists and whether its hooks call both commands. The published CLI works before local dependencies or build output exist. The teardown hook leaves the worktree in place for Paseo's deletion step. For a removal the agent initiates, read the `paseo-alignfirst-workspace` skill, archive first, then use `{{CMD}} workspace remove`.

Keep Paseo-specific lifecycle instructions out of the project's agent instructions and assistant guides.
