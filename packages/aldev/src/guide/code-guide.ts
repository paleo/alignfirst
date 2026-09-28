import type { CodingAgent } from "../code/coding-agent.js";
import type { Platform } from "../config.js";
import { readTemplate } from "../templates.js";

export type GuideVariant = "generic" | Platform;

// Each variant owns a full guide (templates/guide/code/<variant>-guide.md) carrying its own
// platform-specific prose. Two shared blocks fill the tags common to every variant:
//   {{INTRODUCTION}}  — what `aldev code` is and how to invoke it
//   {{CLI_REFERENCE}} — the CLI reference and the protocol workflows below it
// {{MODELS}} — the host's model list — is replaced last so the tag also resolves inside the
// inserted blocks.
export function renderCodeGuide(
  variant: GuideVariant,
  agent: CodingAgent,
  models: readonly string[],
): string {
  return readCodeTemplate(`${variant}-guide.md`)
    .replaceAll("{{INTRODUCTION}}", readCodeTemplate("introduction.md").trimEnd())
    .replaceAll("{{CLI_REFERENCE}}", readCodeTemplate("cli-reference.md").trimEnd())
    .replaceAll("{{AGENT}}", agent)
    .replaceAll(
      "{{AUTH_COMMAND}}",
      agent === "claude" ? "`claude`, then `/login`" : "`codex login`",
    )
    .replaceAll(
      "{{PERMISSIONS}}",
      agent === "claude"
        ? "Normal runs use `--permission-mode auto`. `code.skipPermissions: true` in the aldev config selects `--dangerously-skip-permissions`"
        : "Normal runs use `--sandbox workspace-write`. `code.skipPermissions: true` in the aldev config selects `--dangerously-bypass-approvals-and-sandbox`",
    )
    .replaceAll("{{MODELS}}", models.map((model) => `\`${model}\``).join(", "))
    .trimEnd();
}

function readCodeTemplate(name: string): string {
  return readTemplate(`guide/code/${name}`);
}
