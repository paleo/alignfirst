import type { CommandForms } from "../command-form.js";
import { PLATFORMS, type Platform } from "../config.js";
import { readTemplate } from "../templates.js";

export const SURFACES = ["slack", "discord", "app"] as const;

const GUIDE_FILE_CONDITIONS = ["developers", "readme", "noGuide"] as const;

// Active for both guide files: `developers` and `readme`.
const HAS_GUIDE = "hasGuide";

// Derived facts: `thread` holds on Slack and Discord; `conversation` in an app conversation and
// under codingAgent.
const THREAD = "thread";
const CONVERSATION = "conversation";

const MARKER = /^\{\{([#/])([A-Za-z]+)\}\}$/;

// The OpenClaw surface a guide is rendered for.
export type Surface = (typeof SURFACES)[number];

// The project's guide file for the assistant: `DEVELOPERS.md`, `README.md`, or none.
export type GuideFileCondition = (typeof GUIDE_FILE_CONDITIONS)[number];

export interface ActiveBlocks {
  platform: Platform;
  surface?: Surface; // openclaw only
  guideFile?: GuideFileCondition; // codingAgent only
}

interface OpenBlock {
  name: BlockName;
  line: number;
}

type BlockName = Platform | Surface | typeof THREAD | typeof CONVERSATION | ConditionName;

type ConditionName = GuideFileCondition | typeof HAS_GUIDE;

// Renders `templates/guide/<name>`: the blocks first, then the placeholders — the command forms,
// the guide command of the render, and every key of `values`.
export function renderGuideTemplate(
  name: string,
  active: ActiveBlocks,
  forms: CommandForms,
  values: Readonly<Record<string, string>> = {},
): string {
  const placeholders: Record<string, string> = {
    ALIGNDEV: forms.aligndev,
    ALIGNFIRST: forms.alignfirst,
    ...guidePlaceholder(active, forms),
    BACKGROUND_COMMAND_JSON: JSON.stringify(
      `${forms.aligndev} code new --message-file '/tmp/aligndev-request.txt' --quiet --meta 'a20bc7c1-c056-4d07-8cc2-90fe491a6df6'`,
    ),
    ...values,
  };
  let text = renderBlocks(readTemplate(`guide/${name}`), active, name);
  for (const [key, value] of Object.entries(placeholders)) {
    text = text.replaceAll(`{{${key}}}`, () => value);
  }
  return text.trimEnd();
}

// `{{GUIDE}}` carries the surface into every later guide call. An OpenClaw render without a surface
// has none.
function guidePlaceholder(active: ActiveBlocks, forms: CommandForms): Record<string, string> {
  if (active.surface !== undefined) {
    return { GUIDE: `${forms.aligndev} guide --channel ${active.surface}` };
  }
  return active.platform === "codingAgent" ? { GUIDE: `${forms.aligndev} guide` } : {};
}

// A block is `{{#<name>}}` … `{{/<name>}}`, each marker alone on its line, and names a fact. A
// platform block sits at the top level. A surface block and `thread` never sit inside a
// `codingAgent` block; a condition block always does, at any depth; `conversation` sits anywhere.
// A line is kept when every block around it holds. The runs of empty lines that removed blocks
// leave collapse to one.
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

function isActive(name: BlockName, active: ActiveBlocks): boolean {
  if (name === THREAD) return active.surface === "slack" || active.surface === "discord";
  if (name === CONVERSATION) return active.surface === "app" || active.platform === "codingAgent";
  if (name === HAS_GUIDE) return active.guideFile === "developers" || active.guideFile === "readme";
  return name === active.platform || name === active.surface || name === active.guideFile;
}

function openBlock(
  name: string,
  line: number,
  open: readonly OpenBlock[],
  templateName: string,
): OpenBlock {
  const insideCodingAgent = open.some((block) => block.name === "codingAgent");
  if (isPlatform(name)) {
    const outer = open.at(-1);
    if (outer !== undefined) {
      throw blockError(templateName, line, `platform block "${name}" inside "${outer.name}"`);
    }
    return { name, line };
  }
  if (isSurface(name) || name === THREAD) {
    if (insideCodingAgent) {
      const block = isSurface(name) ? `surface block "${name}"` : `block "${name}"`;
      throw blockError(templateName, line, `${block} inside a codingAgent block`);
    }
    return { name, line };
  }
  if (name === CONVERSATION) return { name, line };
  if (isCondition(name)) {
    if (!insideCodingAgent) {
      throw blockError(templateName, line, `condition block "${name}" outside a codingAgent block`);
    }
    return { name, line };
  }
  throw blockError(templateName, line, `unknown block "${name}"`);
}

function closeBlock(name: string, line: number, open: OpenBlock[], templateName: string): void {
  if (!isBlockName(name)) throw blockError(templateName, line, `unknown block "${name}"`);
  if (open.at(-1)?.name !== name) {
    throw blockError(templateName, line, `closing marker "${name}" without its block`);
  }
  open.pop();
}

function isBlockName(name: string): name is BlockName {
  return (
    isPlatform(name) ||
    isSurface(name) ||
    name === THREAD ||
    name === CONVERSATION ||
    isCondition(name)
  );
}

function isPlatform(name: string): name is Platform {
  return (PLATFORMS as readonly string[]).includes(name);
}

export function isSurface(name: string): name is Surface {
  return (SURFACES as readonly string[]).includes(name);
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
