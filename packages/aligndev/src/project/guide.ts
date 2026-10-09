import { dirname } from "node:path";

import type { CommandForms } from "../command-form.js";
import { renderGuideTemplate } from "../guide/render-template.js";
import type { ProjectInventory, ProjectsDirectory } from "./discovery.js";
import { escapeAdditionalJsonCharacters, formatRange } from "./format.js";
import type { MarkerPortRange, PortRange } from "./markers.js";

// The projects guide serves the OpenClaw playbook only.
export function renderProjectsGuide(forms: CommandForms, inventory?: ProjectInventory): string {
  const guide = renderGuideTemplate("project.md", { platform: "openclaw" }, forms);
  if (inventory === undefined) return guide;
  const sections = inventory.directories.map((directory) => renderDirectory(inventory, directory));
  return `${guide}\n\n${sections.join("\n\n")}`;
}

function renderDirectory(inventory: ProjectInventory, directory: ProjectsDirectory): string {
  const lines = [`## Directory ${renderData(directory.path)}`];
  if (directory.description !== undefined) {
    lines.push("", `Description: ${renderData(directory.description)}`);
  }
  lines.push("", "Port ranges:");
  if (directory.portRanges === undefined) lines.push("- (none)");
  else {
    for (const range of directory.portRanges) lines.push(`- ${renderMarkerRange(range)}`);
  }
  lines.push("", "Projects:");
  const projects = inventory.projects.filter((project) => project.directory === directory.path);
  if (projects.length === 0) lines.push("- (none)");
  else {
    for (const project of projects) {
      lines.push(
        `- ${renderData(project.name)} — ${renderProjectRange(project.portRange, project.portRangeCode)}`,
      );
    }
  }
  lines.push("", "Nested directories:");
  const nested = inventory.directories.filter(
    (candidate) => candidate.path !== directory.path && dirname(candidate.path) === directory.path,
  );
  if (nested.length === 0) lines.push("- (none)");
  else {
    for (const child of nested) {
      lines.push(`- ${renderData(child.path)} — ${renderRanges(child.portRanges)}`);
    }
  }
  return lines.join("\n");
}

function renderData(value: string): string {
  const escaped = escapeAdditionalJsonCharacters(JSON.stringify(value));
  const delimiter = "`".repeat(longestBacktickRun(escaped) + 1);
  return `${delimiter}${escaped}${delimiter}`;
}

function longestBacktickRun(value: string): number {
  let longest = 0;
  for (const [run] of value.matchAll(/`+/gu)) longest = Math.max(longest, run.length);
  return longest;
}

function renderRange(range: PortRange | undefined, absent = "(none)"): string {
  return range === undefined ? absent : formatRange(range);
}

function renderProjectRange(range: PortRange | undefined, code: string | undefined): string {
  const rendered = renderRange(range, "(portless)");
  return `${rendered}${code === undefined ? "" : ` (${code})`}`;
}

function renderRanges(ranges: MarkerPortRange[] | undefined): string {
  return ranges === undefined ? "(none)" : ranges.map(renderMarkerRange).join(", ");
}

function renderMarkerRange(range: MarkerPortRange): string {
  const code = range.code ?? "default";
  const description = range.description === undefined ? "" : ` — ${renderData(range.description)}`;
  return `${formatRange(range)} (${code})${description}`;
}
