import { relative } from "node:path";

import type { InventoryIssue, ProjectInventory, SkippedDirectory } from "./discovery.js";
import { escapeAdditionalJsonCharacters, escapeControlCharacters, formatRange } from "./format.js";
import type { CompanionReport, ItemLocation } from "./layout.js";
import type { PortRange } from "./ports.js";
import type { ProjectDetails } from "./status.js";

export function renderProjectList(inventory: ProjectInventory): string {
  const lines = [`Root: ${renderOutputValue(inventory.root)}`, "", "Projects:"];
  if (inventory.projects.length === 0) lines.push("  (none)");
  for (const project of inventory.projects) {
    lines.push(
      `- Name: ${renderOutputValue(project.name)}`,
      `  Path: ${renderOutputValue(project.path)}`,
      `  Directory: ${renderOutputValue(project.directory)}`,
      `  Port range: ${renderRange(project.portRange)}`,
      `  AlignDev profile: ${renderNullableValue(project.description.aligndev?.profile ?? null)}`,
      `  Workspaces: ${renderValues(project.workspaces)}`,
    );
  }
  lines.push("", "Skipped directories:");
  if (inventory.skippedDirectories.length === 0) lines.push("  (none)");
  for (const skipped of inventory.skippedDirectories) {
    lines.push(`- ${renderSkippedDirectory(skipped)}`);
  }
  lines.push("", "Issues:");
  if (inventory.issues.length === 0) lines.push("  (none)");
  for (const issue of inventory.issues) {
    lines.push(`- ${renderOutputValue(issue.path)}: ${escapeControlCharacters(issue.message)}`);
  }
  return `${lines.join("\n")}\n`;
}

function renderSkippedDirectory({ path, reason }: SkippedDirectory): string {
  return `${renderOutputValue(path)} (${reason})`;
}

export function renderProjectListJson(inventory: ProjectInventory): string {
  const report = {
    root: inventory.root,
    projects: inventory.projects.map((project) => ({
      name: project.name,
      path: project.path,
      directory: project.directory,
      portRange: project.portRange ?? null,
      companion: project.description.companion,
      aligndev: project.description.aligndev,
      locations: project.description.locations,
      workspaces: project.workspaces,
    })),
    skippedDirectories: inventory.skippedDirectories,
    issues: inventory.issues.map(({ path, message }) => ({ path, message })),
  };
  return renderJson(report);
}

export function renderProjectDoctor(inventory: ProjectInventory): string {
  const lines =
    inventory.issues.length === 0
      ? [`[ok] Project inventory: ${renderCount(inventory.projects.length, "project")}`]
      : inventory.issues.map(renderInventoryIssue);
  for (const skipped of inventory.skippedDirectories) {
    lines.push(`[info] Skipped directory: ${renderSkippedDirectory(skipped)}`);
  }
  return `${lines.join("\n")}\n`;
}

function renderCount(value: number, singular: string): string {
  return `${value} ${singular}${value === 1 ? "" : "s"}`;
}

function renderInventoryIssue(issue: InventoryIssue): string {
  if (issue.conflict !== undefined) {
    const { left, right } = issue.conflict;
    return (
      `[error] Port conflict: ${renderOutputValue(left.path)} (${renderRange(left.portRange)}) ` +
      `overlaps ${renderOutputValue(right.path)} (${renderRange(right.portRange)})`
    );
  }
  return (
    `[error] Project inventory: ${renderOutputValue(issue.path)}: ` +
    escapeControlCharacters(issue.message)
  );
}

export function renderProjectDoctorFailure(message: string): string {
  return `[error] Project inventory: ${escapeControlCharacters(message)}\n`;
}

export function renderProjectStatus(details: ProjectDetails): string {
  const lines = [
    "Project:",
    `  Name: ${renderOutputValue(details.name)}`,
    `  Path: ${renderOutputValue(details.path)}`,
    `  Directory: ${renderOutputValue(details.directory)}`,
    `  Remote host: ${renderNullableValue(details.remoteHost)}`,
    `  Port range: ${renderRange(details.portRange)}`,
    `  Config source: ${details.configSource ?? "(none)"}`,
    `  Companion: ${renderCompanion(details.companion)}`,
    `  AlignDev profile: ${renderNullableValue(details.aligndev?.profile ?? null)}`,
    `  Assistant instructions: ${renderLocation(details.locations.assistantInstructionsFile)}`,
    `  Work files: ${renderLocation(details.locations[".plans"])}`,
    `  Work-files folder: ${renderNullableValue(details.plansFolder)}`,
    `  Ticket id pattern: ${renderNullableValue(details.ticketIdPattern)}`,
    `  Workspaces: ${renderValues(details.workspaces)}`,
    "  Worktrees:",
  ];
  if (details.worktrees.length === 0) lines.push("    (none)");
  for (const worktree of details.worktrees) {
    lines.push(
      `  - Name: ${renderOutputValue(worktree.name)}`,
      `    Path: ${renderOutputValue(worktree.path)}`,
      `    Branch: ${worktree.branch === null ? "(detached)" : renderOutputValue(worktree.branch)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function renderCompanion(companion: CompanionReport | null): string {
  if (companion === null) return "(none)";
  return renderPath(companion.dir, companion.exists);
}

function renderLocation(location: ItemLocation | null): string {
  if (location === null) return "(not configured)";
  return renderPath(location.path, location.exists);
}

function renderPath(path: string, exists: boolean): string {
  return `${renderOutputValue(path)}${exists ? "" : " (missing)"}`;
}

export function renderProjectStatusJson(details: ProjectDetails): string {
  return renderJson(details);
}

export function renderFreePortsJson(inventory: ProjectInventory, range: PortRange): string {
  return renderJson({ first: range.first, last: range.last, unknown: unknownProjects(inventory) });
}

// Paths relative to the scan root of the projects whose port range is unknown.
function unknownProjects(inventory: ProjectInventory): string[] {
  return inventory.unreadableProjects.map((path) => relative(inventory.root, path));
}

export function renderUnknownRangeWarnings(inventory: ProjectInventory, aligndev: string): string {
  return unknownProjects(inventory)
    .map(
      (project) =>
        `Warning: unknown port range for ${renderOutputValue(project)}: its configuration ` +
        `report failed. Run \`${aligndev} project doctor\`.\n`,
    )
    .join("");
}

export function renderProjectPorts(inventory: ProjectInventory): string {
  const claims = sortedPortClaims(inventory);
  if (claims.length === 0) return "(none)\n";
  const width = Math.max(...claims.map((claim) => formatRange(claim).length));
  return claims
    .map(
      (claim) => `${formatRange(claim).padEnd(width)}  ${escapeControlCharacters(claim.project)}\n`,
    )
    .join("");
}

export function renderProjectPortsJson(inventory: ProjectInventory): string {
  return renderJson({
    root: inventory.root,
    ranges: sortedPortClaims(inventory),
    unknown: unknownProjects(inventory),
  });
}

interface PortClaim extends PortRange {
  // Relative to the scan root.
  project: string;
}

function sortedPortClaims(inventory: ProjectInventory): PortClaim[] {
  return inventory.projects
    .flatMap(({ path, portRange }): PortClaim[] =>
      portRange === undefined
        ? []
        : [
            {
              first: portRange.first,
              last: portRange.last,
              project: relative(inventory.root, path),
            },
          ],
    )
    .toSorted(
      (left, right) => left.first - right.first || left.project.localeCompare(right.project),
    );
}

function renderJson(value: unknown): string {
  return `${escapeAdditionalJsonCharacters(JSON.stringify(value, undefined, 2))}\n`;
}

function renderRange(range: PortRange | null | undefined): string {
  return range ? formatRange(range) : "(none)";
}

function renderValues(values: string[]): string {
  return values.length === 0 ? "(none)" : values.map(renderOutputValue).join(", ");
}

function renderNullableValue(value: string | null): string {
  return value === null ? "(none)" : renderOutputValue(value);
}

function renderOutputValue(value: string): string {
  return escapeAdditionalJsonCharacters(JSON.stringify(value));
}
