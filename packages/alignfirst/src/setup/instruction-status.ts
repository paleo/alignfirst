import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { CommandContext } from "../context.js";
import { displayPath } from "../format.js";
import { findMainWorktree } from "../git.js";
import { layoutOf, projectRoot } from "../project-layout.js";
import {
  type BootstrapLocation,
  diagnoseInstructions,
  type InstructionDiagnosis,
  type InstructionFile,
  type InstructionStatus,
  insertSection,
} from "./instructions.js";
import { PROJECT_PATH_PLACEHOLDER, renderSetupTemplate } from "./topics.js";

const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

export interface InstructionReport {
  status: InstructionStatus | "global";
  diagnosis: InstructionDiagnosis;
  /** The worktree root holding the instruction files. */
  root: string;
}

/** `global` takes precedence: a companion with a `companion` default keeps the repository untouched. */
export function inspectInstructions(ctx: CommandContext): InstructionReport {
  const root = projectRoot(ctx.cwd);
  const diagnosis = diagnoseInstructions(readInstructionFiles(root), renderBootstrapSection(ctx));
  const global = layoutOf(ctx).companion?.defaultLocation === "companion";
  return { status: global ? "global" : diagnosis.status, diagnosis, root };
}

function readInstructionFiles(root: string): InstructionFile[] {
  const seen = new Set<string>();
  const files: InstructionFile[] = [];
  for (const name of INSTRUCTION_FILES) {
    const path = join(root, name);
    if (!statSync(path, { throwIfNoEntry: false })?.isFile()) continue;
    const real = realpathSync(path);
    if (seen.has(real)) continue;
    seen.add(real);
    files.push({ path, content: readFileSync(path, "utf-8") });
  }
  return files;
}

export function renderBootstrapSection(ctx: CommandContext): string {
  return renderSetupTemplate(ctx, "snippets/bootstrap.md");
}

export function renderGlobalBootstrapSection(ctx: CommandContext, root: string): string {
  const mainWorktree = findMainWorktree(root) ?? root;
  return renderSetupTemplate(ctx, "snippets/global-bootstrap.md").replaceAll(
    PROJECT_PATH_PLACEHOLDER,
    () => mainWorktree,
  );
}

/**
 * Inserts the canonical section in `file`, else `AGENTS.md` when it exists, else an existing
 * `CLAUDE.md`, else a new `AGENTS.md`. Returns the written path.
 */
export function writeBootstrapSection(
  ctx: CommandContext,
  root: string,
  file: string | undefined,
): string {
  const path = file === undefined ? defaultTarget(root) : resolve(ctx.cwd, file);
  const content = existsSync(path) ? readFileSync(path, "utf-8") : "";
  writeFileSync(path, insertSection(content, renderBootstrapSection(ctx)));
  return path;
}

function defaultTarget(root: string): string {
  const [agents, claude] = INSTRUCTION_FILES.map((name) => join(root, name));
  if (existsSync(agents) || !existsSync(claude)) return agents;
  return claude;
}

/** One line: the status, its location, and the command when action is needed. */
export function describeInstructions(ctx: CommandContext, report: InstructionReport): string {
  const { locations } = report.diagnosis;
  const where = locations.map((location) => formatLocation(ctx, location)).join(", ");
  switch (report.status) {
    case "current":
      return `current (${where})`;
    case "absent":
      return `absent; insert it: ${ctx.form} setup instructions --write`;
    case "global":
      return `global (companion defaultLocation); see ${ctx.form} setup instructions`;
    default:
      return `${report.status} (${where}); see ${ctx.form} setup instructions`;
  }
}

export function describeLegacySections(ctx: CommandContext, report: InstructionReport): string[] {
  return report.diagnosis.legacySections.map(
    (section) => `legacy section ${formatLocation(ctx, section)} (${section.heading.trim()})`,
  );
}

export function formatLocation(
  ctx: CommandContext,
  { path, line }: Pick<BootstrapLocation, "path" | "line">,
): string {
  return `${displayPath(ctx.cwd, path)}:${line}`;
}

export function fenced(markdown: string): string {
  return `\`\`\`markdown\n${markdown.trim()}\n\`\`\`\n`;
}
