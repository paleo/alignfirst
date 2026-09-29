import type { CodingAgent } from "../code/coding-agent.js";
import type { CommandForms } from "../command-form.js";
import type { Platform } from "../config.js";
import { renderGuideTemplate } from "./render-template.js";

export function renderCodeGuide(
  platform: Platform,
  agent: CodingAgent,
  models: readonly string[],
  forms: CommandForms,
): string {
  return renderGuideTemplate("code.md", platform, forms, {
    AGENT: agent,
    AUTH_COMMAND: agent === "claude" ? "`claude`, then `/login`" : "`codex login`",
    PERMISSIONS:
      agent === "claude"
        ? "Normal runs use `--permission-mode auto`, plus `--add-dir <companion>` when the project's AlignFirst files live in its companion directory. `code.skipPermissions: true` in the aldev config selects `--dangerously-skip-permissions`"
        : "Normal runs use `--sandbox workspace-write`, plus `--add-dir <companion>` when the project's AlignFirst files live in its companion directory. `code.skipPermissions: true` in the aldev config selects `--dangerously-bypass-approvals-and-sandbox`",
    MODELS: models.map((model) => `\`${model}\``).join(", "),
    ALIGNFIRST_SETUP: forms.viaNpx
      ? "The project must be prepared for AlignFirst. `npx -y aldev` runs the `alignfirst` CLI through `npx`."
      : "The project must be prepared for AlignFirst, with the `alignfirst` CLI installed (`npm install -g alignfirst`).",
    ALIGNFIRST_USE: forms.viaNpx
      ? "`npx -y aldev code` runs the `alignfirst` CLI through `npx`, and so does the coder: it runs `npx -y alignfirst guide <protocol>` in the project."
      : "`aldev code` requires the `alignfirst` CLI on `PATH`. The coder runs `alignfirst guide <protocol>` in the project, so the protocols come from the installed CLI.",
  });
}
