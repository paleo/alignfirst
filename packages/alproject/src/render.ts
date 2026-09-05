import type { InventoryIssue, ProjectInventory } from "./discovery.js";
import type { PortRange } from "./markers.js";
import type { ProjectDetails } from "./status.js";

export function renderProjectList(inventory: ProjectInventory): string {
  const lines = ["Projects:"];
  if (inventory.projects.length === 0) lines.push("  (none)");
  for (const project of inventory.projects) {
    lines.push(
      `- Name: ${renderOutputValue(project.name)}`,
      `  Path: ${renderOutputValue(project.path)}`,
      `  Directory: ${renderOutputValue(project.directory)}`,
      `  Port range: ${renderRange(project.portRange)}`,
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
    lines.push(
      `  Port range: ${renderRange(directory.portRange)}`,
      `  Others: ${renderValues(directory.others)}`,
    );
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
      portRange: directory.portRange ?? null,
      others: directory.others,
    })),
    projects: inventory.projects.map((project) => ({
      name: project.name,
      path: project.path,
      directory: project.directory,
      portRange: project.portRange ?? null,
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
    `  Port range: ${renderRange(details.portRange ?? undefined)}`,
    `  Plans folder: ${renderNullableValue(details.plansFolder)}`,
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
  return range === undefined ? "(none)" : `${range.first}..${range.last}`;
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

function escapeControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    if (!isControlCharacter(character, true)) return character;
    const jsonEscape = JSON.stringify(character).slice(1, -1);
    return jsonEscape === character ? unicodeEscape(character) : jsonEscape;
  }).join("");
}

function escapeAdditionalJsonCharacters(value: string): string {
  return Array.from(value, (character) =>
    isControlCharacter(character, false) ? unicodeEscape(character) : character,
  ).join("");
}

function isControlCharacter(character: string, includeC0: boolean): boolean {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) return false;
  return (
    (includeC0 && codePoint <= 0x1f) ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029
  );
}

function unicodeEscape(character: string): string {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) throw new Error("Cannot escape an empty character");
  return `\\u${codePoint.toString(16).padStart(4, "0")}`;
}
