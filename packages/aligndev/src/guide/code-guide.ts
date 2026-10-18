import type { CodingAgent } from "../code/coding-agent.js";
import type { CommandForms } from "../command-form.js";
import type { Platform } from "../config.js";
import { renderGuideTemplate } from "./render-template.js";

export function renderCodeGuide(
  platform: Platform,
  agent: CodingAgent,
  models: readonly string[] | undefined,
  defaultModel: string | undefined,
  forms: CommandForms,
): string {
  return renderGuideTemplate("code.md", { platform }, forms, {
    AGENT: agent,
    AUTH_COMMAND:
      agent === "pi"
        ? "`pi`, then `/login <provider>`, or configure provider credentials"
        : agent === "claude"
          ? "`claude`, then `/login`"
          : "`codex login`",
    PERMISSIONS:
      agent === "pi"
        ? "Pi uses ordinary OS permissions, including companion access. `code.skipPermissions` has no effect. Saved project trust is honored; no forced approval is passed"
        : agent === "claude"
          ? "Normal runs use `--permission-mode auto`, plus `--add-dir <companion>` for a project with a companion directory. `code.skipPermissions: true` in the aligndev settings selects `--dangerously-skip-permissions`"
          : "Normal runs use `--sandbox workspace-write`, plus `--add-dir <companion>` for a project with a companion directory. `code.skipPermissions: true` in the aligndev settings selects `--dangerously-bypass-approvals-and-sandbox`",
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
