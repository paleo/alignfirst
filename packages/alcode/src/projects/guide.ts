import { dirname } from "node:path";

import { readTemplate } from "../guide.js";
import type { ProjectInventory, ProjectsDirectory } from "./discovery.js";
import type { PortRange } from "./markers.js";

export function renderProjectsGuide(inventory?: ProjectInventory): string {
  const guide = readTemplate("projects-guide.md").trimEnd();
  if (inventory === undefined) return guide;
  const sections = inventory.directories.map((directory) => renderDirectory(inventory, directory));
  return `${guide}\n\n${sections.join("\n\n")}`;
}

function renderDirectory(inventory: ProjectInventory, directory: ProjectsDirectory): string {
  const lines = [`## Directory ${renderData(directory.path)}`];
  if (directory.description !== undefined) {
    lines.push("", `Description: ${renderData(directory.description)}`);
  }
  lines.push("", `Port range: ${renderRange(directory.portRange)}`, "", "Projects:");
  const projects = inventory.projects.filter((project) => project.directory === directory.path);
  if (projects.length === 0) lines.push("- (none)");
  else {
    for (const project of projects) {
      lines.push(`- ${renderData(project.name)} — ${renderRange(project.portRange, "(portless)")}`);
    }
  }
  lines.push("", "Nested directories:");
  const nested = inventory.directories.filter(
    (candidate) => candidate.path !== directory.path && dirname(candidate.path) === directory.path,
  );
  if (nested.length === 0) lines.push("- (none)");
  else {
    for (const child of nested) {
      lines.push(`- ${renderData(child.path)} — ${renderRange(child.portRange)}`);
    }
  }
  return lines.join("\n");
}

function renderData(value: string): string {
  const escaped = escapeControlCharacters(JSON.stringify(value));
  const delimiter = "`".repeat(longestBacktickRun(escaped) + 1);
  return `${delimiter}${escaped}${delimiter}`;
}

function escapeControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      !((codePoint >= 0x7f && codePoint <= 0x9f) || codePoint === 0x2028 || codePoint === 0x2029)
    ) {
      return character;
    }
    return `\\u${codePoint.toString(16).padStart(4, "0")}`;
  }).join("");
}

function longestBacktickRun(value: string): number {
  let longest = 0;
  for (const [run] of value.matchAll(/`+/gu)) longest = Math.max(longest, run.length);
  return longest;
}

function renderRange(range: PortRange | undefined, absent = "(none)"): string {
  return range === undefined ? absent : `${range.first}..${range.last}`;
}
