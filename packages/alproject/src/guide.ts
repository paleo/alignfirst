import { readFileSync } from "node:fs";
import { join } from "node:path";

import { AlprojectError } from "./errors.js";

const CUSTOM_GUIDE_FILENAME = "alproject-guide.md";

export function renderGuide(root?: string): string {
  const genericGuide = renderGenericGuide();
  if (root === undefined) return genericGuide;
  const customGuide = readCustomGuide(root);
  if (customGuide === undefined) return genericGuide;
  return `${genericGuide.trimEnd()}\n\n---\n\n# Project-specific guide\n\n${customGuide}`;
}

function renderGenericGuide(): string {
  const guide = readFileSync(new URL("../templates/guide.md", import.meta.url), "utf8").replaceAll(
    "{{CONFIG_FILENAME}}",
    ".alproject.json",
  );
  const unresolved = guide.match(/\{\{[^}]+\}\}/u)?.[0];
  if (unresolved !== undefined) {
    throw new AlprojectError("configuration", `Unresolved guide template marker: ${unresolved}`);
  }
  return guide;
}

function readCustomGuide(root: string): string | undefined {
  const path = join(root, CUSTOM_GUIDE_FILENAME);
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw new AlprojectError(
      "filesystem",
      `Cannot read custom guide ${path}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
