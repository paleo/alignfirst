import type { CommandForms } from "../command-form.js";
import { PLATFORMS, type Platform } from "../config.js";
import { readTemplate } from "../templates.js";

const GUIDE_FILE_CONDITIONS = ["developers", "readme", "noGuide"] as const;

// Active for both guide files: `developers` and `readme`.
const HAS_GUIDE = "hasGuide";

const MARKER = /^\{\{([#/])([A-Za-z]+)\}\}$/;

// The project's guide file for the assistant: `DEVELOPERS.md`, `README.md`, or none.
export type GuideFileCondition = (typeof GUIDE_FILE_CONDITIONS)[number];

export interface ActiveBlocks {
  platform: Platform;
  guideFile?: GuideFileCondition;
}

interface OpenBlock {
  name: Platform | ConditionName;
  line: number;
}

type ConditionName = GuideFileCondition | typeof HAS_GUIDE;

// Renders `templates/guide/<name>`: the blocks first, then the placeholders — the command forms
// and every key of `values`.
export function renderGuideTemplate(
  name: string,
  active: ActiveBlocks,
  forms: CommandForms,
  values: Readonly<Record<string, string>> = {},
): string {
  const placeholders: Record<string, string> = {
    ALIGNDEV: forms.aligndev,
    ALIGNFIRST: forms.alignfirst,
    ...values,
  };
  let text = renderBlocks(readTemplate(`guide/${name}`), active, name);
  for (const [key, value] of Object.entries(placeholders)) {
    text = text.replaceAll(`{{${key}}}`, value);
  }
  return text.trimEnd();
}

// A block is `{{#<name>}}` … `{{/<name>}}`, each marker alone on its line. A platform block sits
// at the top level; a condition block sits directly inside a `codingAgent` block. A line
// is kept when every block around it is active. The runs of empty lines that removed blocks leave
// collapse to one.
export function renderBlocks(text: string, active: ActiveBlocks, templateName: string): string {
  const kept: string[] = [];
  const open: OpenBlock[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    const marker = MARKER.exec(line);
    if (marker === null) {
      if (open.every((block) => isActive(block.name, active))) kept.push(line);
      continue;
    }
    const [, kind, name] = marker;
    const lineNumber = index + 1;
    if (kind === "#") open.push(openBlock(name, lineNumber, open, templateName));
    else closeBlock(name, lineNumber, open, templateName);
  }
  const unclosed = open.at(-1);
  if (unclosed !== undefined) {
    throw blockError(templateName, unclosed.line, `block "${unclosed.name}" is not closed`);
  }
  return collapseEmptyLines(kept).join("\n");
}

function isActive(name: OpenBlock["name"], active: ActiveBlocks): boolean {
  if (name === HAS_GUIDE) return active.guideFile === "developers" || active.guideFile === "readme";
  return name === active.platform || name === active.guideFile;
}

function openBlock(
  name: string,
  line: number,
  open: readonly OpenBlock[],
  templateName: string,
): OpenBlock {
  const outer = open.at(-1);
  if (isPlatform(name)) {
    if (outer !== undefined) {
      throw blockError(templateName, line, `platform block "${name}" inside "${outer.name}"`);
    }
    return { name, line };
  }
  if (isCondition(name)) {
    if (outer?.name !== "codingAgent") {
      throw blockError(templateName, line, `condition block "${name}" outside a codingAgent block`);
    }
    return { name, line };
  }
  throw blockError(templateName, line, `unknown block "${name}"`);
}

function closeBlock(name: string, line: number, open: OpenBlock[], templateName: string): void {
  if (!isPlatform(name) && !isCondition(name)) {
    throw blockError(templateName, line, `unknown block "${name}"`);
  }
  if (open.at(-1)?.name !== name) {
    throw blockError(templateName, line, `closing marker "${name}" without its block`);
  }
  open.pop();
}

function isPlatform(name: string): name is Platform {
  return (PLATFORMS as readonly string[]).includes(name);
}

function isCondition(name: string): name is ConditionName {
  return name === HAS_GUIDE || (GUIDE_FILE_CONDITIONS as readonly string[]).includes(name);
}

function blockError(templateName: string, line: number, detail: string): Error {
  return new Error(`Error: template ${templateName}, line ${line}: ${detail}.`);
}

function collapseEmptyLines(lines: string[]): string[] {
  return lines.filter((line, index) => line !== "" || lines[index - 1] !== "");
}
