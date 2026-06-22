import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { extractFallbackTitle, extractMetadata, stripFrontmatter } from "./parser.js";

const SHELL_SAFE_NAME = /^[\w.-]+$/;

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

export interface CheckIssue {
  path: string;
  message: string;
}

// Reads a `.md` file and turns its frontmatter (plus name validation) into a FileEntry. The single
// source of the extractMetadata -> fallback-title -> validateName sequence used across the module.
function buildFileEntry(dirPath: string, name: string): FileEntry {
  const content = readFileSync(join(dirPath, name), "utf-8");
  const meta = extractMetadata(content);
  return {
    name,
    title: meta.title ?? extractFallbackTitle(content),
    summary: meta.summary,
    readWhen: meta.readWhen,
    error: meta.error,
    nameError: validateName(name),
  };
}

export function checkAll(dirPath: string, relDir: string, prefix: string): CheckIssue[] {
  const issues: CheckIssue[] = [];
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return issues;
  }

  for (const entry of entries) {
    const rel = displayPath(prefix, relDir, entry.name);

    if (entry.isDirectory()) {
      const nameWarning = validateName(entry.name);
      if (nameWarning) issues.push({ path: rel, message: nameWarning });
      const subRel = relDir ? `${relDir}/${entry.name}` : entry.name;
      issues.push(...checkAll(join(dirPath, entry.name), subRel, prefix));
    } else if (entry.name.endsWith(".md") && !shouldSkipFile(entry.name)) {
      const file = buildFileEntry(dirPath, entry.name);
      if (file.nameError) issues.push({ path: rel, message: file.nameError });
      if (file.error) issues.push({ path: rel, message: file.error });
      if (!file.title) issues.push({ path: rel, message: "Missing title" });
    }
  }

  return issues;
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

  const files: FileEntry[] = mdFiles.map((name) => buildFileEntry(dirPath, name));

  return { subdirs, files, subdirWarnings };
}

export function formatDirectory(
  dirPath: string,
  title: string,
  result: DirectoryListing,
  relDir: string,
  prefix: string,
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
    lines.push(...formatFileBullets(result.files, relDir, prefix));
    lines.push("");
  }

  return { lines, hasSubdirList: result.subdirs.length > 0, hasFiles: result.files.length > 0 };
}

export function formatRecursive(
  dirPath: string,
  title: string,
  level: number,
  relDir: string,
  prefix: string,
): FormatResult {
  const lines: string[] = [];
  const result = listDirectory(dirPath);
  const hashes = "#".repeat(level);
  const titleDisplay = title.includes("/") ? `\`${title}\`` : title;
  let hasFiles = result.files.length > 0;

  lines.push(`${hashes} ${titleDisplay}`);
  lines.push("");

  if (result.files.length > 0) {
    lines.push(...formatFileBullets(result.files, relDir, prefix));
    lines.push("");
  }

  for (const sub of result.subdirs) {
    const subRelDir = relDir ? `${relDir}/${sub}` : sub;
    const warning = result.subdirWarnings.get(sub);
    if (warning) lines.push(`⚠ ${warning}: ${sub}/`);
    const subResult = formatRecursive(join(dirPath, sub), `${sub}/`, level + 1, subRelDir, prefix);
    lines.push(...subResult.lines);
    if (subResult.hasFiles) hasFiles = true;
  }

  return { lines, hasSubdirList: false, hasFiles };
}

export function formatFileBullets(files: FileEntry[], relDir: string, prefix: string): string[] {
  const lines: string[] = [];

  for (const file of files) {
    const docPath = displayPath(prefix, relDir, file.name);
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

export function readDocFile(
  baseDir: string,
  normalized: string,
  prefix: string,
  getAllFiles: () => string[] = () => collectAllFiles(baseDir, ""),
): { path: string; content: string } | undefined {
  const resolvedBase = resolve(baseDir);
  const resolvedTarget = resolve(resolvedBase, normalized);
  if (isUnder(resolvedBase, resolvedTarget)) {
    try {
      const content = readFileSync(resolvedTarget, "utf-8");
      return { path: displayPath(prefix, normalized), content: stripFrontmatter(content) };
    } catch {
      // fall through to recursive search
    }
  }

  const allFiles = getAllFiles();
  const found = allFiles.find((rel) => rel === normalized || rel.endsWith(`/${normalized}`));
  if (!found) return;

  const content = readFileSync(join(baseDir, found), "utf-8");
  return { path: displayPath(prefix, found), content: stripFrontmatter(content) };
}

export function searchDocs(baseDir: string, terms: string[], prefix: string): string[] {
  const needles = terms.map((term) => term.toLowerCase());
  const lines: string[] = [];
  for (const rel of collectAllFiles(baseDir, "")) {
    const slash = rel.lastIndexOf("/");
    const relDir = slash === -1 ? "" : rel.slice(0, slash);
    const name = slash === -1 ? rel : rel.slice(slash + 1);
    const entry = buildFileEntry(join(baseDir, relDir), name);
    const haystack = [rel, entry.title, entry.summary, ...entry.readWhen]
      .filter((part): part is string => part !== undefined)
      .join(" ")
      .toLowerCase();
    if (!needles.every((needle) => haystack.includes(needle))) continue;
    lines.push(...formatFileBullets([entry], relDir, prefix));
  }
  return lines;
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

// Counts `.md` files (recursively, CHANGELOG* excluded) but stops walking as soon as `limit`
// is reached, so a multi-thousand-file tree is not fully traversed just to compare against a
// small threshold. The returned count is capped at `limit`.
export function countFilesUpTo(dirPath: string, limit: number): number {
  let count = 0;
  const walk = (dir: string): boolean => {
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (walk(join(dir, entry.name))) return true;
      } else if (entry.name.endsWith(".md") && !shouldSkipFile(entry.name)) {
        count++;
        if (count >= limit) return true;
      }
    }
    return false;
  };
  walk(dirPath);
  return count;
}

function displayPath(...parts: string[]): string {
  return parts.filter((part) => part.length > 0).join("/");
}

function validateName(name: string): string | undefined {
  return SHELL_SAFE_NAME.test(name) ? undefined : "Name contains spaces or special characters";
}

function shouldSkipFile(name: string): boolean {
  return name.startsWith("CHANGELOG");
}

export function isUnder(base: string, target: string): boolean {
  if (target === base) return true;
  const rel = relative(base, target);
  return rel.length > 0 && rel !== ".." && !rel.startsWith(`..${sep}`);
}
