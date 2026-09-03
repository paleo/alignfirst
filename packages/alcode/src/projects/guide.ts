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
  const lines = [`## ${directory.path}`];
  if (directory.description !== undefined) lines.push("", directory.description);
  lines.push("", `Port range: ${renderRange(directory.portRange)}`, "", "Projects:");
  const projects = inventory.projects.filter((project) => project.directory === directory.path);
  if (projects.length === 0) lines.push("- (none)");
  else {
    for (const project of projects) {
      lines.push(`- ${project.name} — ${renderRange(project.portRange, "(portless)")}`);
    }
  }
  lines.push("", "Nested directories:");
  const nested = inventory.directories.filter(
    (candidate) => candidate.path !== directory.path && dirname(candidate.path) === directory.path,
  );
  if (nested.length === 0) lines.push("- (none)");
  else {
    for (const child of nested) {
      lines.push(`- ${child.path} — ${renderRange(child.portRange)}`);
    }
  }
  return lines.join("\n");
}

function renderRange(range: PortRange | undefined, absent = "(none)"): string {
  return range === undefined ? absent : `${range.first}..${range.last}`;
}
