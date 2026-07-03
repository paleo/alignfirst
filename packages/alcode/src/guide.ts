import { readFileSync } from "node:fs";

export type GuideVariant = "generic" | "openclaw";

// templates/guide.md is the shared skeleton; the per-variant fragments fill its tags:
//   {{TITLE-SUFFIX}} — appended to the H1 to label the variant
//   {{RUN}}          — how to background the run on the caller's platform
//   {{WAKE}}         — how the completion wake arrives, introducing the shared steps
export function renderGuide(variant: GuideVariant): string {
  return readTemplate("guide.md")
    .replaceAll("{{TITLE-SUFFIX}}", variant === "openclaw" ? " (OpenClaw)" : "")
    .replaceAll("{{RUN}}", readTemplate(`guide-run-${variant}.md`).trimEnd())
    .replaceAll("{{WAKE}}", readTemplate(`guide-wake-${variant}.md`).trimEnd())
    .trimEnd();
}

function readTemplate(name: string): string {
  return readFileSync(new URL(`../templates/${name}`, import.meta.url), "utf-8");
}
