import { readFileSync } from "node:fs";

import type { CodingAgent } from "./coding-agent.js";

export type GuideVariant = "generic" | "openclaw";

// Each variant owns a full guide (templates/<variant>-guide.md) carrying its own
// platform-specific prose. Two shared blocks fill the tags common to every variant:
//   {{INTRODUCTION}}  — what alcode is and how to invoke it
//   {{CLI_REFERENCE}} — the CLI reference and the protocol workflows below it
// {{MODELS}} — the host's model list — is replaced last so the tag also resolves inside the
// inserted blocks.
export function renderGuide(
  variant: GuideVariant,
  agent: CodingAgent,
  models: readonly string[],
): string {
  return readTemplate(`${variant}-guide.md`)
    .replaceAll("{{INTRODUCTION}}", readTemplate("introduction.md").trimEnd())
    .replaceAll("{{CLI_REFERENCE}}", readTemplate("cli-reference.md").trimEnd())
    .replaceAll("{{AGENT}}", agent)
    .replaceAll(
      "{{AUTH_COMMAND}}",
      agent === "claude" ? "`claude`, then `/login`" : "`codex login`",
    )
    .replaceAll(
      "{{PERMISSIONS}}",
      agent === "claude"
        ? "Normal runs use `--permission-mode auto`. `ALIGNFIRST_CODE_SKIP_PERMISSIONS=1` selects `--dangerously-skip-permissions`"
        : "Normal runs use `--sandbox workspace-write`. `ALIGNFIRST_CODE_SKIP_PERMISSIONS=1` selects `--dangerously-bypass-approvals-and-sandbox`",
    )
    .replaceAll("{{MODELS}}", models.map((model) => `\`${model}\``).join(", "))
    .trimEnd();
}

export function readTemplate(name: string): string {
  return readFileSync(new URL(`../templates/${name}`, import.meta.url), "utf-8");
}
