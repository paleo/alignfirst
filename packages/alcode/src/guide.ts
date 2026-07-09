import { readFileSync } from "node:fs";

export type GuideVariant = "generic" | "openclaw";

// Each variant owns a full guide (templates/<variant>-guide.md) carrying its own
// platform-specific prose. Two shared blocks fill the tags common to every variant:
//   {{INTRODUCTION}}  — what alcode is and how to invoke it
//   {{CLI_REFERENCE}} — the CLI reference and the protocol workflows below it
export function renderGuide(variant: GuideVariant): string {
  return readTemplate(`${variant}-guide.md`)
    .replaceAll("{{INTRODUCTION}}", readTemplate("introduction.md").trimEnd())
    .replaceAll("{{CLI_REFERENCE}}", readTemplate("cli-reference.md").trimEnd())
    .trimEnd();
}

function readTemplate(name: string): string {
  return readFileSync(new URL(`../templates/${name}`, import.meta.url), "utf-8");
}
