import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CliError } from "../cli-error.js";
import { errorMessage } from "../errors.js";
import { displayPath, formatLocalTimestamp, formatSize } from "../format.js";
import type { ResolvedTicketDir, TicketEntry } from "./ticket.js";

const MAX_FILE_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 30 * 1024;
const PLAN_FILE = /^[A-Z]\d+-(?:main-plan|plan-.*)\.md$/;
const OMISSION_NOTICE = `Content omitted: over the ${formatSize(MAX_FILE_BYTES)} limit.`;
const TOO_LARGE_NOTICE = `History too large to print (over the ${formatSize(MAX_OUTPUT_BYTES)} budget). Read the relevant files among the entries above, skipping the plans (\`*-plan.md\`, \`*-main-plan.md\`, \`*-plan-*.md\`): the specs and \`.summary.md\` files provide the catch-up context.`;

interface CatchupFile {
  /** Absolute, for reading. */
  path: string;
  /** Relative to the working directory when inside it, for the heading. */
  displayPath: string;
  size: number;
  modified: string;
}

export function renderCatchup(cwd: string, ticket: ResolvedTicketDir, report: string): string {
  const files = ticket.entries.flatMap((entry) => catchupFile(cwd, ticket.dir, entry));
  if (files.length === 0) return `${report}\nNo Markdown files to load.\n`;
  const outputBytes = files.reduce(
    (total, file) => total + sectionBytes(file),
    Buffer.byteLength(report) + 1,
  );
  if (outputBytes > MAX_OUTPUT_BYTES) return `${report}\n${TOO_LARGE_NOTICE}\n`;
  return `${report}\n${files.map(renderSection).join("")}`;
}

function catchupFile(cwd: string, dir: string, entry: TicketEntry): CatchupFile[] {
  if (entry.size === undefined || !isHistoryFile(entry.name)) return [];
  const path = join(dir, entry.name);
  return [
    {
      path,
      displayPath: displayPath(cwd, path),
      size: entry.size,
      modified: formatLocalTimestamp(entry.modifiedAt),
    },
  ];
}

function isHistoryFile(name: string): boolean {
  return name.endsWith(".md") && (name.endsWith(".summary.md") || !PLAN_FILE.test(name));
}

function sectionBytes(file: CatchupFile): number {
  const body = isOversized(file) ? Buffer.byteLength(OMISSION_NOTICE) : file.size;
  return Buffer.byteLength(wrapSection(file, "")) + body;
}

function isOversized(file: CatchupFile): boolean {
  return file.size > MAX_FILE_BYTES;
}

function wrapSection(file: CatchupFile, body: string): string {
  return `<file path="${file.displayPath}" modified="${file.modified}">\n${body}\n</file>\n\n`;
}

function renderSection(file: CatchupFile): string {
  const body = isOversized(file) ? OMISSION_NOTICE : readBody(file);
  return wrapSection(file, body.replace(/\n+$/, ""));
}

function readBody(file: CatchupFile): string {
  try {
    return readFileSync(file.path, "utf-8");
  } catch (error) {
    throw new CliError(`Cannot load catchup file ${file.displayPath}: ${errorMessage(error)}`);
  }
}
