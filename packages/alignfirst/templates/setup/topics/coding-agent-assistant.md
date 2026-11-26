# A Coding Agent as the Assistant

Claude Code, Codex, Antigravity or a persistent Pi session can act as the AlignFirst assistant. It works on the repository where its session starts, and on any project designated by a path. It follows the `aligndev` playbook and delegates through `aligndev code`. The assistant's harness and the agent's harness are independent. No OpenClaw deployment is needed.

Supported systems: Linux and macOS, and Windows through WSL.

## 1. Prepare the project

The project meets the contract of `{{CMD}} setup guide assistant-project`. For a repository that must stay untouched, follow `{{CMD}} setup guide companion`; companion selection requires authorization and preserves old project content without copying it.

A fresh harness worktree can be adopted in place through `{{CMD}} workspace setup` after the playbook selects its branch.

Retired wrappers, settings or state require `{{CMD}} setup guide upgrade-workspaces`.

## 2. Configure `aligndev` (recommended)

Without settings, the agent runs with the built-in defaults of the assistant's harness. To configure profiles, write `~/.alignfirst/aligndev.settings.json`:

```json
{
  "code": {
    "profiles": {
      "claude-personal": { "harness": "claude", "defaultAgentProfile": "codex-personal" },
      "codex-personal": { "harness": "codex" }
    }
  }
}
```

A profile's required `harness` is `claude`, `codex`, `pi` or `agy`. Profiles are complete, without inheritance. A profile with `"disabled": true` is ignored.

The assistant's profile is the enabled profile that describes the session: it has the assistant's harness, and its `configDir` is compatible with the session's native directory variable. `null` matches an unset variable and a path matches the same directory. An omitted `configDir` matches any session, but only when no `null` or path profile matches. Among several candidates, the one with `default: true` wins; without it, the launch fails and lists the candidates. At most one `default: true` per harness is allowed. The assistant's profile launches the agent itself, or delegates to the profile named by its `defaultAgentProfile`. In the example, a Claude Code session delegates to Codex through `codex-personal`; a Codex session matches `codex-personal` and delegates to Codex too.

New-session, help, `guide code` and quota selection is `--profile` → actual-cwd project registry selection → on resume, the latest recorded named profile → the assistant's profile or its `defaultAgentProfile` → the built-ins of the assistant's harness. `code.fallbackProfile` replaces the built-ins only when the assistant's harness is OpenClaw or unrecognized, such as a shell outside any coding agent. `ALIGNDEV_ASSISTANT_HARNESS` forces the assistant's harness for one invocation. A named reference that is missing, disabled or an `openclaw` profile fails. A deleted recorded name requires an explicit or project replacement. Historical null or missing profiles use the built-ins of the assistant's harness unless an explicit or project selection replaces them. The original transcript stays unchanged. Help, guide and quota share the resolver outside Git and `.plans`. Status reads durable metadata without validating launch settings.

Unknown or obsolete settings keys are ignored with value-free warnings on stderr. Recognized invalid values and duplicate defaults still fail. The CLI never rewrites settings or applies retired launch or default-map semantics. For existing settings, follow the sections "Convert AlignDev Launch Settings", "Convert AlignDev Profile Defaults" and "Convert AlignDev Harness Settings" of `{{CMD}} setup guide upgrade`.

### Native-directory selection

`configDir` selects native storage through `CLAUDE_CONFIG_DIR`, `CODEX_HOME` or `PI_CODING_AGENT_DIR`. It has three states:

- **Omitted:** inherit the caller's variable unless profile `env` or `unset` changes it; without a variable, native defaults apply. Use omission for ordinary Claude, Codex and Pi setup. Do not add a directory-selection question unless the user asks to select a specific native configuration.
- **Null:** deliberately remove the variable to force native-default directory behavior despite an inherited override. `"configDir": null` resets directory routing only; HOME, PATH and API-key precedence remain unchanged.
- **String:** resolve and set the variable for an intentional selection, such as `"~/.claude-work"`. A string naming a default path remains an explicit selection. `~/` uses the configured home; relative paths use the settings directory.

On macOS, explicitly setting `CLAUDE_CONFIG_DIR` to the default path can select different Keychain credentials from leaving it unset. Confirm the user's intended mode before changing an existing string. AlignDev performs no settings rewrite, automatic login or credential transfer.

A string or null `configDir` conflicts with its matching native variable in `env` or `unset`.

An `agy` profile takes no `configDir`. Antigravity keeps one store under `~/.gemini` and its account in the OS keyring: one account per OS user.

### Environment and models

Profiles can supply literal non-secret `env` values and remove inherited variables with `unset`. No shell expansion occurs. Credentials remain in native stores or provisioned process environments. A variable cannot appear in both fields.

Before login, reproduce the agent's effective environment and cwd: apply `unset`, `env` and `configDir`, including HOME, PATH and credential routing. Help and guides identify storage-variable origins without printing their values. A bare login in another shell may select another account.

For Pi, prefer provider-qualified `modelAliases` targets. Exact IDs pin a model; fuzzy native selectors and thinking suffixes pass unchanged to Pi. For example, separate `pi-codex` and `pi-anthropic` profiles can map `sol` to `openai/sol` and `opus` to `anthropic/opus`, using separately provisioned native configurations. AlignDev never infers their providers or account identity. Targets are illustrative and depend on the native catalog. One alias expands after validating the chosen name, without recursion.

Without a nonempty profile `models`, Pi and Antigravity accept any nonblank selector, and Claude and Codex accept their built-in names plus configured aliases. A nonempty list replaces the accepted names. New sessions use the profile's `defaultModel`, else the native default.

A nonempty profile `efforts` replaces the harness's built-in effort levels and bounds what `--effort` accepts. New sessions use the profile's `defaultEffort`, which must be one of the accepted levels, else the native default. A resume keeps its recorded effort. Under Pi, an effort overrides a thinking suffix of the model selector.

For Antigravity, prefer a base model name with an effort, such as `--model gemini-3.8-flash --effort low`. A name with an effort suffix conflicts with a different effort, a profile's `defaultEffort` included, and the run fails. The catalog depends on the account: `agy models` lists it.

Resume retains and validates its recorded user-facing model, ignoring profile defaults. Disallowed names require `--model`; null keeps the native conversation model. Current alias mappings apply even to retained names. The selected native account must contain the original conversation; cross-agent resumes fail, and Pi requires the recorded real directory. No fallback account or replacement conversation is accepted.

The [`aligndev` README](https://github.com/paleo/alignfirst/tree/main/packages/aligndev#configuration) documents every profile field and the independent quota settings. Omitted quota uses a native Claude, Codex or Antigravity profile's effective environment. For Pi, follow "Optional quota setup for Pi" below. Quota selection follows new-session precedence, needs no ticket or `.plans`, and never changes the agent.

### Credentials

Check whether the developer's shell exports `ANTHROPIC_API_KEY` (Claude Code) or `CODEX_API_KEY` (Codex). Check the names only; never print the values. The agent runs non-interactively (`claude -p`, `codex exec`), where such a key overrides the subscription login, even when the developer's own session declined it. When the developer wants the agent on their subscription, list the key in the profile's `unset`:

```json
{
  "code": {
    "profiles": {
      "claude-personal": {
        "harness": "claude", "unset": ["ANTHROPIC_API_KEY"]
      }
    }
  }
}
```

For a Pi agent, start `pi` under the account and configuration the agent will use and run `/login <provider>`, or configure the provider's credentials. Pi uses its native credential precedence; the Claude and Codex environment-key rules above do not apply. Inspect only credential-variable names, never values. Saved project trust must cover the execution directory and the required project resources; do not force `--approve` to bypass missing trust.

For an Antigravity agent, run `agy` once interactively, under the OS user that will run the agent, and sign in.

### Optional quota setup for Pi

Codex CLI is not required to run Pi, including Pi's ChatGPT subscription route. It is an optional quota helper when `quota.source` is `codex`. The `claude` source likewise requires Claude Code; `none` requires neither CLI. Pi without an explicit quota source has no supported quota reader.

1. **Choose the source deliberately:** `codex`, `claude` or `none`. Never infer the provider or account from a model alias. Native quota reports describe the selected CLI's account limits. Codex's ChatGPT limits and Claude's subscription limits do not measure arbitrary provider or API-key billing, Anthropic Console usage or another provider's allowance. Use `none` when no native account quota is relevant.
2. **Install the chosen CLI if it is absent** from the quota environment's PATH. Obtain approval before a global installation. Use only the vendor installer below, which places the binary under `~/.local/bin`; add that directory to PATH when it is missing.

   ```sh
   curl -fsSL https://chatgpt.com/codex/install.sh | sh   # Codex
   curl -fsSL https://claude.ai/install.sh | bash         # Claude Code
   ```

   For Codex, `npm install -g @openai/codex` under the account's Node is the alternative.
3. **Configure quota in the Pi profile** in `~/.alignfirst/aligndev.settings.json`. For example:

   ```json
   {
     "code": {
       "profiles": {
         "pi-quota": {
           "harness": "pi",
           "quota": {
             "source": "codex",
             "configDir": "~/.codex-pi-quota",
             "unset": ["CODEX_API_KEY", "OPENAI_API_KEY"]
           }
         }
       }
     }
   }
   ```

   Explicit quota starts from the original caller environment, applies only quota's own `unset`, `env` and source-specific `configDir`, then strips the assistant session's identities. Pi profile overrides are not copied. The path and validation rules of the coding profile apply. Choose `quota.configDir` only when needed. Omission inherits the quota source's variable independently from the original caller; quota `env` or `unset` may change it. Null deliberately removes `CODEX_HOME` for Codex or `CLAUDE_CONFIG_DIR` for Claude. A string sets explicit storage, as in this custom-account example. Coding and explicit-quota directory resets do not affect each other; neither selects Pi's store. For an ordinary Claude quota source, `{ "source": "claude" }` needs no directory field.

   For Claude subscription quota, replace the quota object with `{ "source": "claude", "configDir": "~/.claude-pi-quota", "unset": ["ANTHROPIC_API_KEY"] }`. To disable quota, use only `{ "source": "none" }`, without other quota fields, including `configDir: null`.
4. **Authenticate the native CLI separately.** The human completes login under the same OS user, cwd and effective environment or configuration directory as the quota query. Reproduce quota's `unset`, `env` and `configDir`, including HOME, PATH and any credential routing. Pi's `auth.json` and `/login` credentials are not imported into Codex or Claude Code. Never copy tokens between their stores.

   For the Codex example above, with ordinary HOME and PATH and no additional credential routing:

   ```sh
   mkdir -p "$HOME/.codex-pi-quota"
   env -u CODEX_API_KEY -u OPENAI_API_KEY CODEX_HOME="$HOME/.codex-pi-quota" codex login
   ```

   For the Claude subscription alternative:

   ```sh
   mkdir -p "$HOME/.claude-pi-quota"
   env -u ANTHROPIC_API_KEY CLAUDE_CONFIG_DIR="$HOME/.claude-pi-quota" claude auth login --claudeai
   ```

   Adapt these commands to the actual quota environment; a bare login in another shell may authenticate another store or route. Inspect credential-variable names only. Keep secrets out of chat, settings examples, shell history and logs. Complete browser or device authentication privately.
5. **Confirm the intended account pairing.** When quota should represent Pi's allowance, compare the identity and organization or workspace selected during the native login with those used for Pi's relevant provider login. A shared email alone may not establish the same allowance. For existing logins, use the provider's account UI or native identity information where available; do not dump credential files. AlignDev does not verify account identity. A successful login or quota retrieval alone does not prove a match.

   Once separately authenticated, `aligndev code quota --profile pi-quota` reads the selected native account's limits. The report labels the profile and source, not a verified Pi account. If the pairing cannot be established, treat it only as that CLI's quota or select `none`.

For an OpenClaw Pi deployment, installation and native authentication target the service account and its effective service environment instead; follow the `aligndev-openclaw-setup` skill.

### Global assistant instructions

`~/.alignfirst/ASSISTANTS.md` is optional. It holds the developer's instructions to the assistant for every project, such as which profile to use for each kind of task. See the [`aligndev` README](https://github.com/paleo/alignfirst/tree/main/packages/aligndev#global-assistant-instructions).

## 3. Install the skill globally

The `aligndev` skill goes in the developer's global agent configuration. Use the installation command of `{{CMD}} setup guide skills`, which includes it; to install the playbook alone, keep only `--skill aligndev`. Restart the agent after installation.

Without a skill, add the "AlignDev" section from the [`aligndev` README](https://github.com/paleo/alignfirst/tree/main/packages/aligndev#without-a-skill) to the developer's global agent instructions instead. The user then asks the session to work with aligndev.

### Claude Code launch timeout

When the assistant's harness is Claude Code, recommend merging this into `~/.claude/settings.json` to allow delegated runs beyond two hours:

```json
{
  "env": {
    "BASH_MAX_TIMEOUT_MS": "86400000"
  }
}
```

Preserve existing settings and other `env` entries. If the assistant's session uses `CLAUDE_CONFIG_DIR`, use that directory's `settings.json`. This raises the Bash timeout ceiling to 24 hours. Launches still need an explicit `timeout` set to the maximum stated by the assistant's Bash tool, alongside `run_in_background`. Restart Claude Code after changing the setting.

### Paseo

When the user uses Paseo, follow `{{CMD}} setup guide paseo`.

## 4. Install Pi tools for the requested roles

The skill supplies instructions only. Neither extension installs it, the CLI, profiles or the other extension. Obtain approval before a global installation:

- **Pi as the assistant's harness:** `pi install npm:@alignfirst/pi-background`. This generic tool runs the ordinary quoted `aligndev code` command; the playbook supplies `--quiet`, a unique run identity, result retrieval and workflow decisions.
- **Pi as the agent's harness:** `pi install npm:@alignfirst/pi-subagent` in the agent's environment, for isolated plan and review assignments. The assistant still delegates through `aligndev code`, never directly through `subagent`.

Install both when both roles use Pi. Before installing the packaged subagent replacement, identify any existing extension registering `subagent` and obtain explicit approval to disable it through `pi config`. Do not overwrite the local extension or profiles, or load both implementations. Reload after installation; `/reload` cancels active jobs and subagents.

Install current stable packages and inspect their declared Pi peer and Node runtime compatibility. A Pi assistant must remain alive after acknowledging a launch; print or JSON one-shot processes do not qualify. A missing `background` capability is a setup blocker, not permission to block on bash or detach with `&`. Manual compaction or cancelled navigation can delay notices; interruption or queue clearing can lose automatic continuation. Submitted notices can survive navigation or reload, so validate current handle ownership before acting. Delivery is not exactly once, and shutdown cancels work without crash recovery. See [Pi Extensions](https://github.com/paleo/alignfirst/blob/main/docs/pi-extensions.md) and the linked package READMEs for the contracts.

## 5. Start the assistant

Start the assistant's harness in the project's repository and invoke `/aligndev` in Claude Code or Antigravity, `$aligndev` in Codex, or `/skill:aligndev` in Pi. The skill runs `npx -y aligndev guide`, or `bunx --bun aligndev guide` with Bun; no global AlignDev CLI installation is required. Confirm skill discovery and the requested tools without changing trust or settings merely to test them.

A session can also work on other projects, and its starting directory need not be a Git repository. The user's request, the starting directory's instructions or `~/.alignfirst/ASSISTANTS.md` give each project's path. The assistant stays in its starting directory and runs each command in the project's directory. There it writes work files, Git state and workspaces, never the codebase. The harness must allow a directory that holds the projects and their workspaces, typically their common parent, with `--add-dir` in Claude Code or Codex.

## Permissions

As the assistant's harness, Claude Code, Codex and Antigravity use their established elevation: request escalated permissions in Codex, disable Claude Code's sandbox for the launch when it is enabled, or run every `aligndev` and `alignfirst` command outside Antigravity's sandbox. The developer approves those requests because the agent needs network access and writes outside the project.

Pi and both extensions use ordinary OS permissions. The cwd controls discovery, not filesystem isolation. Saved project trust controls resource loading, not tool access. A profile's `skipPermissions` has no effect on Pi. The CLI prepares companions and injects project context; the generic tool only honors the command and cwd.

### Antigravity permissions

A delegated run uses Antigravity's auto mode. Its commands run first in a terminal sandbox: no network, a read-only home, and the workspace, `/tmp` and the companion directory writable.

The sandbox hides other directories, the main checkout of a linked git worktree included. From a linked worktree, AlignDev also makes the repository's common git directory writable, so `git` commands run in the sandbox, commits included. The rest of the main checkout stays hidden.

Antigravity starts its shell in the writable directory whose path sorts first, the companion or the git directory included. AlignDev's prompt names the working directory, and the agent runs its commands there.

Antigravity may let a command leave the sandbox, by its own evaluation. In a headless run, it refuses `npx` commands, and nothing can approve them. A delegated protocol then stops at its first `alignfirst` command.

Two settings let it run. On a trusted machine, the recommended one is `"skipPermissions": true` on the `agy` profile, which removes the sandbox:

```json
{
  "code": {
    "profiles": {
      "antigravity": { "harness": "agy", "skipPermissions": true }
    }
  }
}
```

The narrower one is an allow rule in `~/.gemini/antigravity-cli/settings.json`. After a failed sandboxed attempt, the command runs outside the sandbox:

```json
{ "permissions": { "allow": ["command(npx)"] } }
```

The rule names the project's runner: `npx`, `bunx` or the installed binary.

The sandbox hides `/run/user/<uid>`. A version manager that links `node` there, such as fnm's multishell, leaves sandboxed commands without `node`.

AlignDev never edits Antigravity's settings.
