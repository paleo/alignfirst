import type { CommandForms } from "../command-form.js";
import { PLATFORMS, type Platform } from "../config.js";
import { readTemplate } from "../templates.js";

const MARKER = /^\{\{([#/])([A-Za-z]+)\}\}$/;

// Renders `templates/guide/<name>`: the platform blocks first, then the placeholders — the command
// forms and every key of `values`.
export function renderGuideTemplate(
  name: string,
  platform: Platform,
  forms: CommandForms,
  values: Readonly<Record<string, string>> = {},
): string {
  const placeholders: Record<string, string> = {
    ALIGNDEV: forms.aligndev,
    ALIGNFIRST: forms.alignfirst,
    ...values,
  };
  let text = renderPlatformBlocks(readTemplate(`guide/${name}`), platform, name);
  for (const [key, value] of Object.entries(placeholders)) {
    text = text.replaceAll(`{{${key}}}`, value);
  }
  return text.trimEnd();
}

// A block is `{{#<platform>}}` … `{{/<platform>}}`, each marker alone on its line. The active
// platform's blocks keep their content; the others are removed. Blocks do not nest. The runs of
// empty lines that removed blocks leave collapse to one.
export function renderPlatformBlocks(
  text: string,
  platform: Platform,
  templateName: string,
): string {
  const kept: string[] = [];
  let open: { platform: string; line: number } | undefined;
  for (const [index, line] of text.split("\n").entries()) {
    const marker = MARKER.exec(line);
    if (marker === null) {
      if (open === undefined || open.platform === platform) kept.push(line);
      continue;
    }
    const [, kind, name] = marker;
    const lineNumber = index + 1;
    if (!isPlatform(name)) {
      throw blockError(templateName, lineNumber, `unknown platform "${name}"`);
    }
    if (kind === "#") {
      if (open !== undefined) {
        throw blockError(templateName, lineNumber, `block "${name}" nested in "${open.platform}"`);
      }
      open = { platform: name, line: lineNumber };
    } else {
      if (open?.platform !== name) {
        throw blockError(templateName, lineNumber, `closing marker "${name}" without its block`);
      }
      open = undefined;
    }
  }
  if (open !== undefined) {
    throw blockError(templateName, open.line, `block "${open.platform}" is not closed`);
  }
  return collapseEmptyLines(kept).join("\n");
}

function isPlatform(name: string): name is Platform {
  return (PLATFORMS as readonly string[]).includes(name);
}

function blockError(templateName: string, line: number, detail: string): Error {
  return new Error(`Error: template ${templateName}, line ${line}: ${detail}.`);
}

function collapseEmptyLines(lines: string[]): string[] {
  return lines.filter((line, index) => line !== "" || lines[index - 1] !== "");
}
