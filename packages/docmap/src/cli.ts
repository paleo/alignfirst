import { existsSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  checkAll,
  collectAllFiles,
  formatDirectory,
  formatRecursive,
  listDirectory,
  readDocFile,
  type FormatResult,
} from "./formatter.js";

export interface MainOptions {
  argv?: string[];
  stdout?: { write(s: string): void };
  stderr?: { write(s: string): void };
  cwd?: string;
}

export function main(options?: MainOptions): number {
  const argv = options?.argv ?? process.argv;
  const stdout = options?.stdout ?? process.stdout;
  const stderr = options?.stderr ?? process.stderr;
  const cwd = options?.cwd ?? process.cwd();

  const { paths, unknownFlags, recursive, root, check } = parseArgs(argv);
  const baseDir = root ? resolve(cwd, root) : resolve(cwd, "docs");
  const prefix = relative(cwd, baseDir);

  for (const flag of unknownFlags) stderr.write(`Unknown option: ${flag} (ignored)\n`);

  if (check) {
    const issues = checkAll(baseDir, "", prefix);
    for (const issue of issues) stdout.write(`${issue.path}: ${issue.message}\n`);
    return issues.length > 0 ? 1 : 0;
  }

  const { dirs, files } = classifyTargets(baseDir, paths, prefix);

  const listing = renderListing(baseDir, dirs, recursive, paths.length === 0, cwd, prefix);
  if (listing) stdout.write(listing);

  const reads = renderReads(baseDir, files, prefix);
  if (reads) {
    if (listing) stdout.write("\n");
    stdout.write(reads);
  }

  return 0;
}

export interface ParsedArgs {
  paths: string[];
  unknownFlags: string[];
  recursive: boolean;
  root: string | undefined;
  check: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const paths: string[] = [];
  const unknownFlags: string[] = [];
  let recursive = false;
  let root: string | undefined;
  let check = false;

  for (let i = 0; i < args.length; ++i) {
    const arg = args[i];
    if (arg === "--root" && i + 1 < args.length) {
      root = args[++i];
    } else if (arg === "--recursive") {
      recursive = true;
    } else if (arg === "--check") {
      check = true;
    } else if (arg.startsWith("--")) {
      unknownFlags.push(arg);
    } else {
      paths.push(arg);
    }
  }

  return { paths, unknownFlags, recursive, root, check };
}

interface ClassifiedTargets {
  dirs: string[];
  files: FileTarget[];
}

interface FileTarget {
  original: string;
  normalized: string;
}

function classifyTargets(baseDir: string, paths: string[], prefix: string): ClassifiedTargets {
  const dirs: string[] = [];
  const files: FileTarget[] = [];
  for (const original of paths) {
    const normalized = normalizeTarget(original, prefix);
    if (isDirectory(resolve(baseDir, normalized))) dirs.push(normalized);
    else files.push({ original, normalized });
  }
  return { dirs, files };
}

function normalizeTarget(arg: string, prefix: string): string {
  const trimmed = arg.replace(/\/+$/, "");
  if (prefix.length > 0 && (trimmed === prefix || trimmed.startsWith(`${prefix}/`)))
    return trimmed.slice(prefix.length).replace(/^\/+/, "");
  return trimmed;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function renderListing(
  baseDir: string,
  dirs: string[],
  recursive: boolean,
  noPositionals: boolean,
  cwd: string,
  prefix: string,
): string {
  const targets = listingTargets(baseDir, dirs, recursive, noPositionals);
  if (targets.length === 0) return "";

  const allLines: string[] = [];
  let anySubdirList = false;
  let anyFiles = false;
  for (const { targetDir, rootTitle, rootRelDir } of targets) {
    const formatted: FormatResult = recursive
      ? formatRecursive(targetDir, rootTitle, 1, rootRelDir, prefix)
      : formatDirectory(targetDir, rootTitle, listDirectory(targetDir), rootRelDir, prefix);
    allLines.push(...formatted.lines);
    if (formatted.hasSubdirList) anySubdirList = true;
    if (formatted.hasFiles) anyFiles = true;
  }

  let out = `${allLines.join("\n")}\n`;
  const tip = formatTip(anySubdirList, anyFiles, prefix, cwd);
  if (tip) out += tip;
  return out;
}

function formatTip(
  anySubdirList: boolean,
  anyFiles: boolean,
  prefix: string,
  cwd: string,
): string | undefined {
  const examples: string[] = [];
  if (anySubdirList) examples.push("dir-name-a", "dir-name-b");
  if (anyFiles)
    examples.push(
      displayExample(prefix, "dir-name-a", "doc-1.md"),
      displayExample(prefix, "dir-name-b", "doc-2.md"),
    );
  if (examples.length === 0) return;
  const pm = detectPackageManager(cwd);
  return `Tip: Pass several paths in one call — directories are listed, files are read. E.g. \`${pm} ${examples.join(" ")}\`.\n`;
}

function displayExample(prefix: string, dir: string, file: string): string {
  return [prefix, dir, file].filter((part) => part.length > 0).join("/");
}

interface ListingTarget {
  targetDir: string;
  rootTitle: string;
  rootRelDir: string;
}

function listingTargets(
  baseDir: string,
  dirs: string[],
  recursive: boolean,
  noPositionals: boolean,
): ListingTarget[] {
  if (dirs.length > 0)
    return dirs.map((dir) => ({
      targetDir: resolve(baseDir, dir),
      rootTitle: dir ? `${dir}/` : "Documentation",
      rootRelDir: dir,
    }));
  if (noPositionals || recursive)
    return [{ targetDir: baseDir, rootTitle: "Documentation", rootRelDir: "" }];
  return [];
}

function renderReads(baseDir: string, files: FileTarget[], prefix: string): string {
  if (files.length === 0) return "";
  let cachedFiles: string[] | undefined;
  const getAllFiles = (): string[] => (cachedFiles ??= collectAllFiles(baseDir, ""));
  const blocks = files.map(({ original, normalized }) => {
    const result = readDocFile(baseDir, normalized, prefix, getAllFiles);
    if (!result) return `⚠ Not found: ${original}`;
    return `<document_file path="${result.path}">\n${result.content.trimEnd()}\n</document_file>`;
  });
  return `${blocks.join("\n\n")}\n`;
}

function detectPackageManager(cwd: string): string {
  let dir = cwd;
  while (true) {
    if (existsSync(join(dir, "package-lock.json"))) return "npm run docmap --";
    if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm docmap";
    if (existsSync(join(dir, "yarn.lock"))) return "yarn docmap";
    if (existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock")))
      return "bun run docmap";
    const parent = dirname(dir);
    if (parent === dir) return "npx docmap";
    dir = parent;
  }
}
