import { readFileSync } from "node:fs";

export function renderGuide(): string {
  return readFileSync(new URL("../templates/guide.md", import.meta.url), "utf-8").trimEnd();
}
