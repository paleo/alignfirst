import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { extractFallbackTitle, extractMetadata, stripFrontmatter } from "./parser.js";

const SHELL_SAFE_NAME = /^[\w.-]+$/;
function validateName(name: string): string | undefined {
  return SHELL_SAFE_NAME.test(name) ? undefined : "Name contains spaces or special characters";
}

export interface FileEntry {
  name: string;
  title: string | undefined;
  summary: string | undefined;
  readWhen: string[];
  error: string | undefined;
  nameError: string | undefined;
}

export interface DirectoryListing {
  subdirs: string[];
  files: FileEntry[];
  subdirWarnings: Map<string, string>;
}

export interface FormatResult {
  lines: string[];
  hasSubdirList: boolean;
  hasFiles: boolean;
}

export function listDirectory(dirPath: string): DirectoryListing {
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return { subdirs: [], files: [], subdirWarnings: new Map() };
  }

  const subdirs: string[] = [];
  const mdFiles: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      subdirs.push(entry.name);
    } else if (entry.name.endsWith(".md") && !shouldSkipFile(entry.name)) {
      mdFiles.push(entry.name);
    }
  }

  subdirs.sort();
  mdFiles.sort();

  const subdirWarnings = new Map<string, string>();
  for (const sub of subdirs) {
    const warning = validateName(sub);
    if (warning) subdirWarnings.set(sub, warning);
  }

  const files: FileEntry[] = mdFiles.map((name) => {
    const content = readFileSync(join(dirPath, name), "utf-8");
    const meta = extractMetadata(content);
    const title = meta.title ?? extractFallbackTitle(content);
    const nameError = validateName(name);
    return {
      name,
      title,
      summary: meta.summary,
      readWhen: meta.readWhen,
      error: meta.error,
      nameError,
    };
  });

  return { subdirs, files, subdirWarnings };
}

export function formatRecursive(
  dirPath: string,
  title: string,
  level: number,
  relDir: string,
): FormatResult {
  const lines: string[] = [];
  const result = listDirectory(dirPath);
  const hashes = "#".repeat(level);
  const titleDisplay = title.includes("/") ? `\`${title}\`` : title;
  let hasFiles = result.files.length > 0;

  lines.push(`${hashes} ${titleDisplay}`);
  lines.push("");

  if (result.files.length > 0) {
    lines.push(...formatFileBullets(result.files, relDir));
    lines.push("");
  }

  for (const sub of result.subdirs) {
    const subRelDir = relDir ? `${relDir}/${sub}` : sub;
    const warning = result.subdirWarnings.get(sub);
    if (warning) lines.push(`⚠ ${warning}: ${sub}/`);
    const subResult = formatRecursive(join(dirPath, sub), `${sub}/`, level + 1, subRelDir);
    lines.push(...subResult.lines);
    if (subResult.hasFiles) hasFiles = true;
  }

  return { lines, hasSubdirList: false, hasFiles };
}

export function formatDirectory(
  dirPath: string,
  title: string,
  result: DirectoryListing,
  relDir: string,
): FormatResult {
  const lines: string[] = [];
  const titleDisplay = title.includes("/") ? `\`${title}\`` : title;

  lines.push(`# ${titleDisplay}`);
  lines.push("");

  if (result.subdirs.length > 0) {
    lines.push("## Sub-directories");
    lines.push("");
    lines.push(...formatSubdirTree(dirPath, result.subdirs, "", result.subdirWarnings));
    lines.push("");
  }

  if (result.files.length > 0) {
    lines.push(...formatFileBullets(result.files, relDir));
    lines.push("");
  }

  return { lines, hasSubdirList: result.subdirs.length > 0, hasFiles: result.files.length > 0 };
}

export function formatFileBullets(files: FileEntry[], relDir: string): string[] {
  const lines: string[] = [];

  for (const file of files) {
    const docPath = relDir ? `docs/${relDir}/${file.name}` : `docs/${file.name}`;
    let line = `- \`${docPath}\``;
    if (file.title) line += ` — ${file.title}`;
    if (file.summary) line += ` — ${file.summary}`;
    if (file.readWhen.length > 0) line += ` *(${file.readWhen.join("; ")})*`;
    lines.push(line);

    if (file.nameError) lines.push(`  ⚠ ${file.nameError}`);
    if (file.error) lines.push(`  ⚠ ${file.error}`);
  }

  return lines;
}

export function formatSubdirTree(
  dirPath: string,
  subdirs: string[],
  indent = "",
  subdirWarnings: Map<string, string> = new Map(),
): string[] {
  const lines: string[] = [];

  for (const sub of subdirs) {
    lines.push(`${indent}- ${sub}/`);
    const warning = subdirWarnings.get(sub);
    if (warning) lines.push(`${indent}  ⚠ ${warning}`);
    const subPath = join(dirPath, sub);
    const childResult = listDirectory(subPath);
    if (childResult.subdirs.length > 0) {
      lines.push(
        ...formatSubdirTree(
          subPath,
          childResult.subdirs,
          `${indent}  `,
          childResult.subdirWarnings,
        ),
      );
    }
  }

  return lines;
}

export function readDocFile(baseDir: string, fileArg: string): { path: string; content: string } {
  let normalized = fileArg.replace(/\/+$/, "");
  if (normalized === "docs" || normalized.startsWith("docs/"))
    normalized = normalized.slice("docs".length).replace(/^\/+/, "");

  // Try as a direct path under docs/
  try {
    const content = readFileSync(resolve(baseDir, normalized), "utf-8");
    return { path: `docs/${normalized}`, content: stripFrontmatter(content) };
  } catch {
    // fall through to recursive search
  }

  // Search recursively for a file whose relative path ends with the given suffix
  const allFiles = collectAllFiles(baseDir, "");
  const found = allFiles.find((rel) => rel === normalized || rel.endsWith(`/${normalized}`));
  if (!found) return { path: fileArg, content: `⚠ File not found: ${fileArg}` };

  const content = readFileSync(join(baseDir, found), "utf-8");
  return { path: `docs/${found}`, content: stripFrontmatter(content) };
}

export function collectAllFiles(dirPath: string, prefix: string): string[] {
  const result: string[] = [];
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      result.push(...collectAllFiles(join(dirPath, entry.name), rel));
    } else if (entry.name.endsWith(".md") && !shouldSkipFile(entry.name)) {
      result.push(rel);
    }
  }
  return result;
}

export interface CheckIssue {
  path: string;
  message: string;
}

export function checkAll(dirPath: string, relDir: string): CheckIssue[] {
  const issues: CheckIssue[] = [];
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return issues;
  }

  for (const entry of entries) {
    const rel = relDir ? `docs/${relDir}/${entry.name}` : `docs/${entry.name}`;
    const nameWarning = validateName(entry.name);

    if (entry.isDirectory()) {
      if (nameWarning) issues.push({ path: rel, message: nameWarning });
      const subRel = relDir ? `${relDir}/${entry.name}` : entry.name;
      issues.push(...checkAll(join(dirPath, entry.name), subRel));
    } else if (entry.name.endsWith(".md") && !shouldSkipFile(entry.name)) {
      if (nameWarning) issues.push({ path: rel, message: nameWarning });
      const content = readFileSync(join(dirPath, entry.name), "utf-8");
      const meta = extractMetadata(content);
      if (meta.error) issues.push({ path: rel, message: meta.error });
      const title = meta.title ?? extractFallbackTitle(content);
      if (!title) issues.push({ path: rel, message: "Missing title" });
    }
  }

  return issues;
}

function shouldSkipFile(name: string): boolean {
  return name.startsWith("CHANGELOG");
}
