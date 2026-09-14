import type { InventoryIssue, ProjectInventory } from "./discovery.js";
import { escapeAdditionalJsonCharacters, escapeControlCharacters, formatRange } from "./format.js";
import type { MarkerPortRange, PortRange } from "./markers.js";
import type { ProjectDetails } from "./status.js";

export function renderProjectList(inventory: ProjectInventory): string {
  const lines = ["Projects:"];
  if (inventory.projects.length === 0) lines.push("  (none)");
  for (const project of inventory.projects) {
    lines.push(
      `- Name: ${renderOutputValue(project.name)}`,
      `  Path: ${renderOutputValue(project.path)}`,
      `  Directory: ${renderOutputValue(project.directory)}`,
      `  Port range: ${renderProjectRange(project.portRange, project.portRangeCode)}`,
      `  Workspaces: ${renderValues(project.workspaces)}`,
    );
  }
  lines.push("", "Directories:");
  if (inventory.directories.length === 0) lines.push("  (none)");
  for (const directory of inventory.directories) {
    lines.push(`- Path: ${renderOutputValue(directory.path)}`);
    if (directory.description !== undefined) {
      lines.push(`  Description: ${renderOutputValue(directory.description)}`);
    }
    if (directory.portRanges === undefined) lines.push("  Port ranges: (none)");
    else {
      lines.push("  Port ranges:");
      for (const range of directory.portRanges) lines.push(`    ${renderMarkerRange(range)}`);
    }
    lines.push(`  Others: ${renderValues(directory.others)}`);
  }
  lines.push("", "Issues:");
  if (inventory.issues.length === 0) lines.push("  (none)");
  for (const issue of inventory.issues) {
    lines.push(`- ${renderOutputValue(issue.path)}: ${escapeControlCharacters(issue.message)}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderProjectListJson(inventory: ProjectInventory): string {
  const report = {
    root: inventory.root,
    directories: inventory.directories.map((directory) => ({
      path: directory.path,
      description: directory.description ?? null,
      portRanges: directory.portRanges ?? [],
      others: directory.others,
    })),
    projects: inventory.projects.map((project) => ({
      name: project.name,
      path: project.path,
      directory: project.directory,
      portRange: project.portRange ?? null,
      portRangeCode: project.portRangeCode ?? null,
      workspaces: project.workspaces,
    })),
    issues: inventory.issues.map(({ path, message }) => ({ path, message })),
  };
  return renderJson(report);
}

export function renderProjectDoctor(inventory: ProjectInventory): string {
  if (inventory.issues.length === 0) {
    return (
      `[ok] Project inventory: ${renderCount(inventory.projects.length, "project")}, ` +
      `${renderCount(inventory.directories.length, "directory")}\n`
    );
  }
  return `${inventory.issues.map(renderInventoryIssue).join("\n")}\n`;
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
    `  Port range: ${renderProjectRange(details.portRange ?? undefined, details.portRangeCode ?? undefined)}`,
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

export function renderProjectStatusJson(details: ProjectDetails): string {
  return renderJson(details);
}

export function renderPortRangeJson(range: PortRange): string {
  return renderJson(range);
}

function renderJson(value: unknown): string {
  return `${escapeAdditionalJsonCharacters(JSON.stringify(value, undefined, 2))}\n`;
}

function renderRange(range: PortRange | undefined): string {
  return range === undefined ? "(none)" : formatRange(range);
}

function renderProjectRange(range: PortRange | undefined, code: string | undefined): string {
  if (range === undefined) return "(none)";
  return `${formatRange(range)}${code === undefined ? "" : ` (${code})`}`;
}

function renderMarkerRange(range: MarkerPortRange): string {
  const code = range.code ?? "default";
  const description =
    range.description === undefined ? "" : ` — ${escapeControlCharacters(range.description)}`;
  return `${formatRange(range)} (${code})${description}`;
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
