import type { CodingAgent } from "../code/coding-agent.js";
import type { CommandForms } from "../command-form.js";
import { CONFIG_DIRECTORY_VARIABLES, type Platform } from "../config.js";
import { renderGuideTemplate } from "./render-template.js";

export function renderCodeGuide(
  platform: Platform,
  agent: CodingAgent,
  models: readonly string[] | undefined,
  defaultModel: string | undefined,
  forms: CommandForms,
  profile: string | null = null,
  nativeStorage = `${CONFIG_DIRECTORY_VARIABLES[agent]}: inherited/default native storage`,
): string {
  return renderGuideTemplate("code.md", { platform }, forms, {
    AGENT: agent,
    PROFILE: profile ?? "(built-in)",
    NATIVE_CONFIG: nativeStorage,
    AUTH_COMMAND:
      agent === "pi"
        ? "`pi`, then `/login <provider>`, or configure provider credentials in the selected native configuration"
        : agent === "claude"
          ? "`claude`, then `/login` in the selected native configuration"
          : "`codex login` in the selected native configuration",
    PERMISSIONS:
      agent === "pi"
        ? "Pi uses ordinary OS permissions, including companion access. `profile.skipPermissions` has no effect. Saved project trust is honored; no forced approval is passed"
        : agent === "claude"
          ? "Normal runs use `--permission-mode auto`, plus `--add-dir <companion>` for a project with a companion directory. `profile.skipPermissions: true` in the aligndev settings selects `--dangerously-skip-permissions`"
          : "Normal runs use `--sandbox workspace-write`, plus `--add-dir <companion>` for a project with a companion directory. `profile.skipPermissions: true` in the aligndev settings selects `--dangerously-bypass-approvals-and-sandbox`",
    MODEL_POLICY:
      models === undefined
        ? "Any nonblank pi-native selector, preferably `provider/model` (thinking suffixes supported)"
        : `One of ${models.map((model) => `\`${model}\``).join(", ")}`,
    DEFAULT_MODEL:
      defaultModel === undefined ? "the coding agent's default" : `\`${defaultModel}\``,
    ALIGNFIRST_SETUP: forms.viaNpx
      ? "The project must be prepared for AlignFirst. `npx -y aligndev` runs the `alignfirst` CLI through `npx`."
      : "The project must be prepared for AlignFirst, with the `alignfirst` CLI installed (`npm install -g alignfirst`).",
    ALIGNFIRST_USE: forms.viaNpx
      ? "`npx -y aligndev code` runs the `alignfirst` CLI through `npx`, and so does the agent: it runs `npx -y alignfirst guide <protocol>` in the project."
      : "`aligndev code` requires the `alignfirst` CLI on `PATH`. The agent runs `alignfirst guide <protocol>` in the project, so the protocols come from the installed CLI.",
  });
}
