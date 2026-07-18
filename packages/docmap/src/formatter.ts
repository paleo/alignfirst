import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { extractFallbackTitle, extractMetadata, stripFrontmatter } from "./parser.js";

const SHELL_SAFE_NAME = /^[\w.-]+$/;

// Extensions docmap lists and reads. All are plain text a human or an agent can read directly;
// binary or hard-to-read formats (PDF, images, office documents) are deliberately excluded.
const LISTABLE_EXTENSIONS = new Set([
  // Markdown and prose
  ".md",
  ".mdx",
  ".markdown",
  ".txt",
  ".text",
  ".rst",
  ".adoc",
  ".asciidoc",
  // Diagrams as text
  ".dsl",
  ".mmd",
  ".mermaid",
  ".drawio",
  ".puml",
  ".plantuml",
  // Markup and structured documents
  ".xml",
  ".html",
  ".htm",
  // Data and config
  ".csv",
  ".tsv",
  ".json",
  ".jsonc",
  ".json5",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  // Schema and IDL formats
  ".sql",
  ".graphql",
  ".gql",
  ".proto",
  ".prisma",
  ".avsc",
  ".avdl",
  ".xsd",
  ".cue",
  ".thrift",
  ".hcl",
  ".jsonschema",
]);

// Only the Markdown family carries YAML frontmatter and a fallback `# heading` title. Other
// listable files show as a bare path and are exempt from frontmatter/title validation.
const MARKDOWN_EXTENSIONS = new Set([".md", ".mdx", ".markdown"]);

// A trailing template suffix (`config.yaml.example`) is stripped before the extension lookup, so
// the template lists on the extension underneath it. Same idea as `.example`: `.sample` and
// `.template` are common, `.dist` survives in the PHP world (e.g. `phpunit.xml.dist`).
const TEMPLATE_SUFFIXES = [".example", ".sample", ".template", ".dist"];

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

// Turns a listable file into a FileEntry. Markdown files contribute frontmatter and a fallback
// heading title; other listable files show as a bare path with no metadata, without being read.
function buildFileEntry(dirPath: string, name: string): FileEntry {
  if (!isMarkdown(name)) return bareEntry(name);
  return entryFromContent(name, readFileSync(join(dirPath, name), "utf-8"));
}

// Builds a FileEntry from content already read — search reads each file once for both metadata
// and body scoring. The single source of the extractMetadata -> fallback-title -> validateName
// sequence used across the module.
export function entryFromContent(name: string, content: string): FileEntry {
  if (!isMarkdown(name)) return bareEntry(name);
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

function bareEntry(name: string): FileEntry {
  return {
    name,
    title: undefined,
    summary: undefined,
    readWhen: [],
    error: undefined,
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
    } else if (isListable(entry.name)) {
      const file = buildFileEntry(dirPath, entry.name);
      if (file.nameError) issues.push({ path: rel, message: file.nameError });
      if (!isMarkdown(entry.name)) continue;
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
  const fileNames: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      subdirs.push(entry.name);
    } else if (isListable(entry.name)) {
      fileNames.push(entry.name);
    }
  }

  subdirs.sort();
  fileNames.sort();

  const subdirWarnings = new Map<string, string>();
  for (const sub of subdirs) {
    const warning = validateName(sub);
    if (warning) subdirWarnings.set(sub, warning);
  }

  const files: FileEntry[] = fileNames.map((name) => buildFileEntry(dirPath, name));

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

  return { lines, hasSubdirList: result.subdirs.length > 0, hasFiles };
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
  if (isSecretEnvFile(basename(normalized))) return;

  const resolvedBase = resolve(baseDir);
  const resolvedTarget = resolve(resolvedBase, normalized);
  if (isUnder(resolvedBase, resolvedTarget)) {
    try {
      const content = readFileSync(resolvedTarget, "utf-8");
      return {
        path: displayPath(prefix, normalized),
        content: readableContent(normalized, content),
      };
    } catch {
      // fall through to recursive search
    }
  }

  const allFiles = getAllFiles();
  const found = allFiles.find((rel) => rel === normalized || rel.endsWith(`/${normalized}`));
  if (!found) return;

  const content = readFileSync(join(baseDir, found), "utf-8");
  return { path: displayPath(prefix, found), content: readableContent(found, content) };
}

// Markdown files are served with their YAML frontmatter stripped; other listable files are
// served verbatim, since frontmatter is a Markdown-only convention.
function readableContent(name: string, content: string): string {
  return isMarkdown(name) ? stripFrontmatter(content) : content;
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
    } else if (isListable(entry.name)) {
      result.push(rel);
    }
  }
  return result;
}

// Counts listable files (recursively, CHANGELOG* excluded) but stops walking as soon as `limit`
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
      } else if (isListable(entry.name)) {
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

function isListable(name: string): boolean {
  if (name.startsWith("CHANGELOG")) return false;
  if (isSecretEnvFile(name)) return false;
  if (isEnvTemplate(name)) return true;
  return LISTABLE_EXTENSIONS.has(extensionOf(name));
}

// A live `.env`, `.env.local`, or `.env.<stage>.local` holds secrets and must never be listed or
// read — this denial wins over every allow rule.
function isSecretEnvFile(name: string): boolean {
  return name === ".env" || name === ".env.local" || /^\.env\..+\.local$/.test(name);
}

// A committed env template documents the variables a service needs: `.env.example` and its
// `.sample`/`.template`/`.dist` variants, optionally with a stage segment (`.env.production.example`).
function isEnvTemplate(name: string): boolean {
  if (!name.startsWith(".env")) return false;
  return TEMPLATE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

export function isMarkdown(name: string): boolean {
  return MARKDOWN_EXTENSIONS.has(extensionOf(name));
}

// The extension used for allowlist matching, with a trailing template suffix removed first so a
// template lists on the format underneath it (`config.yaml.example` -> `.yaml`).
function extensionOf(name: string): string {
  const base = stripTemplateSuffix(name);
  const dot = base.lastIndexOf(".");
  return dot === -1 ? "" : base.slice(dot).toLowerCase();
}

function stripTemplateSuffix(name: string): string {
  const lower = name.toLowerCase();
  for (const suffix of TEMPLATE_SUFFIXES) {
    if (lower.endsWith(suffix)) return name.slice(0, -suffix.length);
  }
  return name;
}

export function isUnder(base: string, target: string): boolean {
  if (target === base) return true;
  const rel = relative(base, target);
  return rel.length > 0 && rel !== ".." && !rel.startsWith(`..${sep}`);
}
