import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Platform } from "../assistant-harness.js";
import { errorMessage, isNodeError } from "../errors.js";

const HEADING = "## Global assistant instructions";

// The dispatcher's last section, built from `~/.alignfirst/ASSISTANTS.md`. The content never passes
// through the template renderer, so placeholders and block markers written by the user stay literal.
export function renderGlobalInstructions(home: string, platform: Platform): string | undefined {
  const path = join(home, ".alignfirst", "ASSISTANTS.md");
  const content = readContent(path);
  const location = `The assistant instructions that apply to every project live in \`${path}\`.`;
  if (content === undefined) {
    if (platform === "openclaw") return;
    return `${HEADING}\n\n${location} None are written yet.`;
  }
  const writer = platform === "openclaw" ? " Only the operator writes to this file." : "";
  return [
    HEADING,
    "",
    `${location}${writer} They override the playbook's defaults. A project's assistant instructions prevail on what concerns that project.`,
    "",
    `<assistant-instructions scope="global" file="${path}">`,
    content,
    "</assistant-instructions>",
  ].join("\n");
}

/** The content with trailing whitespace trimmed, or `undefined` when the file is absent or blank. */
function readContent(path: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw new Error(`Cannot read ${path}: ${errorMessage(error)}`);
  }
  const content = text.trimEnd();
  return content === "" ? undefined : content;
}
