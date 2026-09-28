import { readFileSync } from "node:fs";

// Templates are read at runtime, so edits to a mounted checkout apply without a rebuild.
export function readTemplate(relativePath: string): string {
  return readFileSync(new URL(`../templates/${relativePath}`, import.meta.url), "utf-8");
}
