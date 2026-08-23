import { readFileSync } from "node:fs";
import { join } from "node:path";

import { AlprojectError, errorMessage, isNodeError } from "./errors.js";

const CUSTOM_GUIDE_FILENAME = "alproject-guide.md";

export function renderGuide(root?: string): string {
  const genericGuide = readFileSync(new URL("../templates/guide.md", import.meta.url), "utf8");
  if (root === undefined) return genericGuide;
  const customGuide = readCustomGuide(root);
  if (customGuide === undefined) return genericGuide;
  return `${genericGuide.trimEnd()}\n\n${customGuide}`;
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
